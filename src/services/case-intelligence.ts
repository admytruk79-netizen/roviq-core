import { pool } from '../db/pool.js';

export type CaseIntelligence = {
  caseId: string | null;
  assessmentId: string | null;
  source: 'cloudflare-workers-ai' | 'none';
  status: string | null;
  confidence: number | null;
  requiresHumanReview: boolean;
  suggestedCapabilities: string[];
  suggestedDrivability: string | null;
  safetyFlags: unknown[];
  effectiveForAutomation: boolean;
  rationale: string;
};

/**
 * Reads the latest Cloudflare Workers AI triage assessment attached to the
 * service case for a demand. AI is advisory: only reviewed/accepted results,
 * or a proposed result that explicitly does not require human review, may
 * influence deterministic routing inputs.
 */
export async function loadCaseIntelligenceForDemand(demandId: string): Promise<CaseIntelligence> {
  const result = await pool.query(
    `select sc.id as case_id,
            ai.id as assessment_id,
            ai.model_provider,
            ai.status,
            ai.confidence::float as confidence,
            ai.requires_human_review,
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
      status: null,
      confidence: null,
      requiresHumanReview: true,
      suggestedCapabilities: [],
      suggestedDrivability: null,
      safetyFlags: [],
      effectiveForAutomation: false,
      rationale: 'no_ai_assessment'
    };
  }

  const status = String(row.status || 'proposed');
  const requiresHumanReview = row.requires_human_review !== false;
  const effectiveForAutomation =
    status === 'accepted' || status === 'reviewed' || (status === 'proposed' && !requiresHumanReview);

  return {
    caseId: row.case_id,
    assessmentId: row.assessment_id,
    source: row.model_provider === 'cloudflare-workers-ai' ? 'cloudflare-workers-ai' : 'cloudflare-workers-ai',
    status,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    requiresHumanReview,
    suggestedCapabilities: Array.isArray(row.suggested_capabilities)
      ? row.suggested_capabilities.map(String).filter(Boolean).slice(0, 8)
      : [],
    suggestedDrivability: row.suggested_drivability ? String(row.suggested_drivability) : null,
    safetyFlags: Array.isArray(row.safety_flags) ? row.safety_flags.slice(0, 12) : [],
    effectiveForAutomation,
    rationale: effectiveForAutomation ? `ai_${status}_usable` : `ai_${status}_advisory_only`
  };
}

export function capabilityFromCaseIntelligence(intelligence: CaseIntelligence): string | null {
  if (!intelligence.effectiveForAutomation) return null;
  if (intelligence.suggestedDrivability === 'non_drivable') return 'tow';
  const supported = new Set(['tow', 'diagnostics', 'parts_supply', 'repair']);
  return intelligence.suggestedCapabilities.find((value) => supported.has(value)) ?? null;
}
