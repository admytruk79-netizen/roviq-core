import { createHash } from 'node:crypto';

export type HealthEventKeyInput = {
  sourceId: string;
  vehicleId: string;
  sourceEventId?: string;
  eventType: string;
  occurredAt: string;
  dtcCodes: string[];
  normalizedSignals: Record<string, unknown>;
};

export function healthEventDedupKey(input: HealthEventKeyInput) {
  if (input.sourceEventId) return `source:${input.sourceEventId}`;
  return createHash('sha256').update(JSON.stringify({
    sourceId: input.sourceId,
    vehicleId: input.vehicleId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    dtcCodes: [...input.dtcCodes].sort(),
    normalizedSignals: input.normalizedSignals
  })).digest('hex');
}
