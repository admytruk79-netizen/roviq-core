import { describe, expect, it } from 'vitest';
import { evaluateAssessmentAuthority } from '../src/services/case-intelligence.js';

describe('AI assessment authority boundary', () => {
  it('never automates in shadow mode', () => {
    expect(evaluateAssessmentAuthority({ deploymentMode:'shadow', status:'accepted', requiresHumanReview:false })).toEqual({
      effectiveForAutomation:false,
      rationale:'ai_shadow_observation_only'
    });
  });

  it('never automates in advisory mode', () => {
    expect(evaluateAssessmentAuthority({ deploymentMode:'advisory', status:'reviewed', requiresHumanReview:false }).effectiveForAutomation).toBe(false);
  });

  it('blocks assisted mode when review is required', () => {
    expect(evaluateAssessmentAuthority({ deploymentMode:'assisted', status:'proposed', requiresHumanReview:true }).effectiveForAutomation).toBe(false);
  });

  it('blocks assisted mode when a deterministic safety override exists', () => {
    expect(evaluateAssessmentAuthority({ deploymentMode:'assisted', status:'accepted', requiresHumanReview:false, safetyOverride:true }).effectiveForAutomation).toBe(false);
  });

  it('permits governed assisted output after review gates clear', () => {
    expect(evaluateAssessmentAuthority({ deploymentMode:'assisted', status:'reviewed', requiresHumanReview:false })).toEqual({
      effectiveForAutomation:true,
      rationale:'ai_assisted_reviewed_usable'
    });
  });
});
