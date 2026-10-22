/**
 * MACRE Phase 1: deterministic, dependency-free eligibility checks.
 * This module does not query credentials or change live dispatch.
 * Callers must supply trusted evidence and apply the output before ranking.
 */
export type EvidenceStatus = 'verified' | 'unverified' | 'expired' | 'revoked';
export type ConstraintKind = 'legal_license' | 'oem_certification' | 'manufacturer_access' | 'training' | 'equipment' | 'facility' | 'parts' | 'capacity' | 'authorization';
export type Requirement = {
  id: string;
  kind: ConstraintKind;
  mandatory: boolean;
  scope?: string;
};
export type Evidence = {
  requirementId: string;
  status: EvidenceStatus;
  scope?: string;
  validUntil?: string;
  source?: string;
};
export type ConstraintResult = {
  requirementId: string;
  kind: ConstraintKind;
  satisfied: boolean;
  reason: 'satisfied' | 'missing_evidence' | 'unverified' | 'expired' | 'revoked' | 'scope_mismatch' | 'invalid_expiry';
};
export type EligibilityDecision = {
  decision: 'eligible' | 'blocked' | 'review_required';
  results: ConstraintResult[];
  blockingReasons: string[];
  reviewReasons: string[];
};
function evaluateOne(required: Requirement, provided: readonly Evidence[], now: number): ConstraintResult {
  const candidates = provided.filter(e => e.requirementId === required.id);
  if (candidates.length === 0) return { requirementId: required.id, kind: required.kind, satisfied: false, reason: 'missing_evidence' };
  const results = candidates.map((e): ConstraintResult => {
    const base = { requirementId: required.id, kind: required.kind, satisfied: false };
    if (required.scope && e.scope !== required.scope) return { ...base, reason: 'scope_mismatch' };
    if (e.status === 'revoked') return { ...base, reason: 'revoked' };
    if (e.status === 'expired') return { ...base, reason: 'expired' };
    if (e.status !== 'verified') return { ...base, reason: 'unverified' };
    if (e.validUntil !== undefined) {
      const until = Date.parse(e.validUntil);
      if (!Number.isFinite(until)) return { ...base, reason: 'invalid_expiry' };
      if (until <= now) return { ...base, reason: 'expired' };
    }
    return { ...base, satisfied: true, reason: 'satisfied' };
  });
  return results.find(x => x.satisfied) ?? results[0]!;
}
/**
 * Evaluation is fail-closed on mandatory constraints. Unknown mandatory
 * evidence is a block; missing optional evidence requires human review.
 * Required IDs must be unique to avoid contradictory requirements.
 */
export function evaluateQualification(
  requirements: readonly Requirement[],
  evidence: readonly Evidence[],
  at: Date = new Date()
): EligibilityDecision {
  if (!Number.isFinite(at.getTime())) throw new Error('invalid_evaluation_time');
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement.id || ids.has(requirement.id)) throw new Error('duplicate_or_empty_requirement_id');
    ids.add(requirement.id);
  }
  const results = requirements.map(r => evaluateOne(r, evidence, at.getTime()));
  const blockingReasons: string[] = [];
  const reviewReasons: string[] = [];
  requirements.forEach((req, i) => {
    const result = results[i]!;
    if (result.satisfied) return;
    const label = `${req.kind}:${req.id}:${result.reason}`;
    if (req.mandatory) blockingReasons.push(label);
    else reviewReasons.push(label);
  });
  return {
    decision: blockingReasons.length ? 'blocked' : reviewReasons.length ? 'review_required' : 'eligible',
    results,
    blockingReasons,
    reviewReasons
  };
}
