import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { evaluateAssessmentAuthority, type AiDeploymentMode } from './ai-authority.js';

export type { AiDeploymentMode } from './ai-authority.js';
export { evaluateAssessmentAuthority } from './ai-authority.js';

type Queryable = Pick<PoolClient, 'query'>;

export type CaseIntelligence = {
  caseId: string | null;
  assessmentId: string | null;
  source: 'cloudflare-workers-ai' | 'other-ai' | 'none';
  modelProvider: string | null;
  deploymentMode: AiDeploymentMode | null;
  status: string | null;
  confidence: number | null;
  requiresHumanReview: boolean;
  safetyOverride: boolean;
  suggestedCapabilities: string[];
  suggestedDrivability: string | null;
  safetyFlags: unknown[];
  effectiveForAutomation: boolean;
  rationale: string;
};

/**
 * Cloudflare Workers AI is an intelligence source, not a decision authority.
 * Only ASSISTED-mode assessments that have cleared safety/human-review gates
 * may influence normalized routing inputs. Shadow and advisory assessments are
 * persisted and traceable but never alter automatic provider coordination.
 */
export async function loadCaseIntelligenceForDemand(demandId: string, queryable: Queryable = pool): Promise<CaseIntelligence> {
  const result = await queryable.query(
    `select sc.id as case_id,
            ai.id as assessment_id,
            ai.model_provider,
            ai.deployment_mode,
            ai.status,
            ai.confidence::float as confidence,
            ai.requires_human_review,
            ai.safety_override,
            ai.suggested_capabilities,
            ai.suggested_drivability,
            ai.safety_flags
       from service_cases sc
       left join lateral (
         select a.*
           from ai_triage_assessments a
          where a.case_id=sc.id
          order by a.created_at desc
          limit 1
       ) ai on true
      where sc.demand_id=$1
      order by sc.created_at desc
      limit 1`,
    [demandId]
  );

  const row = result.rows[0];
  if (!row || !row.assessment_id) {
    return {
      caseId: row?.case_id ?? null,
      assessmentId: null,
      source: 'none',
      modelProvider: null,
      deploymentMode: null,
      status: null,
      confidence: null,
      requiresHumanReview: true,
      safetyOverride: false,
      suggestedCapabilities: [],
      suggestedDrivability: null,
      safetyFlags: [],
      effectiveForAutomation: false,
      rationale: 'no_ai_assessment'
    };
  }

  const status = String(row.status || 'proposed');
  const requiresHumanReview = row.requires_human_review !== false;
  const deploymentMode: AiDeploymentMode = ['shadow','advisory','assisted'].includes(String(row.deployment_mode))
    ? String(row.deployment_mode) as AiDeploymentMode
    : 'shadow';
  const safetyOverride = row.safety_override === true;
  const authority = evaluateAssessmentAuthority({ deploymentMode, status, requiresHumanReview, safetyOverride });
  const provider = row.model_provider ? String(row.model_provider) : null;

  return {
    caseId: row.case_id,
    assessmentId: row.assessment_id,
    source: provider === 'cloudflare-workers-ai' ? 'cloudflare-workers-ai' : 'other-ai',
    modelProvider: provider,
    deploymentMode,
    status,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    requiresHumanReview,
    safetyOverride,
    suggestedCapabilities: Array.isArray(row.suggested_capabilities)
      ? row.suggested_capabilities.map(String).filter(Boolean).slice(0, 8)
      : [],
    suggestedDrivability: row.suggested_drivability ? String(row.suggested_drivability) : null,
    safetyFlags: Array.isArray(row.safety_flags) ? row.safety_flags.slice(0, 12) : [],
    effectiveForAutomation: authority.effectiveForAutomation,
    rationale: authority.rationale
  };
}

export function capabilityFromCaseIntelligence(intelligence: CaseIntelligence): string | null {
  if (!intelligence.effectiveForAutomation) return null;
  if (intelligence.suggestedDrivability === 'non_drivable') return 'tow';
  const supported = new Set(['tow', 'diagnostics', 'parts_supply', 'repair']);
  return intelligence.suggestedCapabilities.find((value) => supported.has(value)) ?? null;
}

/** Single capability derivation used by routing and point-of-commit selection checks. */
export async function resolveRequestedCapabilityForDemand(demandId: string, queryable: Queryable = pool): Promise<{
  capability: string;
  intelligence: CaseIntelligence;
}> {
  const demandResult = await queryable.query(
    `select demand_type,attributes from demand_requests where id=$1`,
    [demandId]
  );
  if (!demandResult.rowCount) throw new Error('demand_not_found');
  const demand = demandResult.rows[0];
  const intelligence = await loadCaseIntelligenceForDemand(demandId,queryable);
  const aiCapability = capabilityFromCaseIntelligence(intelligence);
  const explicit = typeof demand.attributes?.requiredCapability === 'string' && demand.attributes.requiredCapability
    ? demand.attributes.requiredCapability
    : null;
  return {
    capability: explicit ?? aiCapability ?? capabilityForDemand(String(demand.demand_type),demand.attributes ?? {}),
    intelligence
  };
}

function capabilityForDemand(demandType:string,attributes:any):string {
  if(attributes?.drivability==='non_drivable') return 'tow';
  if(demandType.includes('diagnostic')||attributes?.requiresDiagnostic===true) return 'diagnostics';
  if(demandType.includes('tow')) return 'tow';
  if(demandType.includes('part')) return 'parts_supply';
  return 'repair';
}
