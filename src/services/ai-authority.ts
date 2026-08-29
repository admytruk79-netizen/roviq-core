export type AiDeploymentMode = 'shadow' | 'advisory' | 'assisted';

export function evaluateAssessmentAuthority(input: {
  deploymentMode: AiDeploymentMode;
  status: string;
  requiresHumanReview: boolean;
  safetyOverride?: boolean;
}) {
  if (input.deploymentMode === 'shadow') return { effectiveForAutomation:false, rationale:'ai_shadow_observation_only' };
  if (input.deploymentMode === 'advisory') return { effectiveForAutomation:false, rationale:'ai_advisory_human_decision_required' };
  if (input.safetyOverride) return { effectiveForAutomation:false, rationale:'ai_safety_override_human_review_required' };
  if (input.requiresHumanReview) return { effectiveForAutomation:false, rationale:'ai_human_review_required' };
  const governedStatus = input.status === 'accepted' || input.status === 'reviewed' || input.status === 'proposed';
  return governedStatus
    ? { effectiveForAutomation:true, rationale:`ai_assisted_${input.status}_usable` }
    : { effectiveForAutomation:false, rationale:`ai_${input.status}_not_authorized` };
}
