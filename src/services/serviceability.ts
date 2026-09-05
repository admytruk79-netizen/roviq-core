import type { CapacityConfidence, CapacityState, SyncState } from './liveCapacity.js';

export type ConstraintStatus = 'required' | 'satisfied' | 'waived' | 'blocked' | 'unknown';

export type ServiceabilityConstraint = {
  type: 'customer_time' | 'resource' | 'capability' | 'parts' | 'mobility' | 'approval' | 'other';
  status: ConstraintStatus;
  required?: boolean;
  details?: Record<string, unknown>;
};

export type ServiceabilityCapacity = {
  capacityState: CapacityState;
  confidence: CapacityConfidence;
  syncState: SyncState;
  capacityUnits: number;
};

export type ServiceabilityInput = {
  capacity?: ServiceabilityCapacity | null;
  constraints?: ServiceabilityConstraint[];
  /** Caller asserts it has projected/checked the requirements applicable to this case. */
  requirementsProjected?: boolean;
  allowManualVerified?: boolean;
  allowStaleHold?: boolean;
};

export type ServiceabilityDecision = {
  eligible: boolean;
  confirmable: boolean;
  holdable: boolean;
  reasons: string[];
};

/**
 * Deterministic, fail-closed serviceability gate.
 *
 * This executes before ranking. It never promotes stale/failed/unknown capacity into
 * confirmed capacity and treats required unsatisfied constraints as blockers.
 */
export function evaluateServiceability(input: ServiceabilityInput): ServiceabilityDecision {
  const reasons: string[] = [];
  const capacity = input.capacity;
  const constraints = input.constraints ?? [];

  if (input.requirementsProjected !== true) reasons.push('requirements_not_projected');

  if (!capacity) reasons.push('capacity_missing');
  else {
    if (capacity.capacityUnits <= 0) reasons.push('capacity_exhausted');
    if (['blocked', 'reserved', 'full', 'unknown'].includes(capacity.capacityState)) reasons.push(`capacity_${capacity.capacityState}`);
    if (['failed', 'degraded'].includes(capacity.syncState)) reasons.push(`sync_${capacity.syncState}`);
    if (capacity.syncState === 'stale') reasons.push('sync_stale');
    if (capacity.syncState === 'manual' && !input.allowManualVerified) reasons.push('manual_capacity_not_authorized');
    if (['unknown', 'stale'].includes(capacity.confidence)) reasons.push(`confidence_${capacity.confidence}`);
    if (capacity.confidence === 'manual_verified' && !input.allowManualVerified) reasons.push('manual_confidence_not_authorized');
  }

  for (const constraint of constraints) {
    const required = constraint.required !== false;
    if (!required || constraint.status === 'waived' || constraint.status === 'satisfied') continue;
    if (constraint.status === 'blocked') reasons.push(`constraint_${constraint.type}_blocked`);
    else if (constraint.status === 'unknown') reasons.push(`constraint_${constraint.type}_unknown`);
    else reasons.push(`constraint_${constraint.type}_unsatisfied`);
  }

  const hardBlock = reasons.some((reason) =>
    reason === 'requirements_not_projected' ||
    reason === 'capacity_missing' ||
    reason === 'capacity_exhausted' ||
    reason === 'capacity_blocked' ||
    reason === 'capacity_reserved' ||
    reason === 'capacity_full' ||
    reason === 'capacity_unknown' ||
    reason === 'sync_failed' ||
    reason === 'sync_degraded' ||
    reason.startsWith('constraint_') ||
    reason === 'manual_capacity_not_authorized' ||
    reason === 'manual_confidence_not_authorized' ||
    reason === 'confidence_unknown'
  );

  const staleOnly = !hardBlock && reasons.length > 0 && reasons.every((reason) => reason === 'sync_stale' || reason === 'confidence_stale');
  const eligible = !hardBlock;
  const confirmable = eligible && !staleOnly && reasons.length === 0;
  const holdable = confirmable || (eligible && staleOnly && input.allowStaleHold === true);

  return { eligible, confirmable, holdable, reasons };
}
