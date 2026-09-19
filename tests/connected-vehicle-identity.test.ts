import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

type HealthEventKeyInput = {
  sourceId: string;
  vehicleId: string;
  sourceEventId?: string;
  eventType: string;
  occurredAt: string;
  dtcCodes: string[];
  normalizedSignals: Record<string, unknown>;
};

function healthEventDedupKey(input: HealthEventKeyInput) {
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

describe('connected vehicle health-event identity', () => {
  const base: HealthEventKeyInput = {
    sourceId: '11111111-1111-4111-8111-111111111111',
    vehicleId: '22222222-2222-4222-8222-222222222222',
    eventType: 'dtc_detected',
    occurredAt: '2026-09-18T20:00:00.000Z',
    dtcCodes: ['P0300', 'P0420'],
    normalizedSignals: { coolantTempC: 96, batteryV: 12.4 }
  };

  it('uses the upstream event id when supplied', () => {
    expect(healthEventDedupKey({ ...base, sourceEventId: 'evt-42' })).toBe('source:evt-42');
  });

  it('is insensitive to DTC ordering', () => {
    const a = healthEventDedupKey(base);
    const b = healthEventDedupKey({ ...base, dtcCodes: ['P0420', 'P0300'] });
    expect(a).toBe(b);
  });

  it('changes when the vehicle changes', () => {
    const a = healthEventDedupKey(base);
    const b = healthEventDedupKey({ ...base, vehicleId: '33333333-3333-4333-8333-333333333333' });
    expect(a).not.toBe(b);
  });
});
