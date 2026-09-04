import { describe, expect, it } from 'vitest';
import { normalizeCapacitySignal } from './liveCapacity.js';

describe('normalizeCapacitySignal', () => {
  it('normalizes native integration signals as integrated current capacity', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_1',
      mode: 'native_integration',
      serviceCategory: 'alignment',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      capacityUnits: 2,
      lastSuccessfulSyncAt: '2026-09-04T17:55:00.000Z',
    }, new Date('2026-09-04T18:00:00.000Z'));

    expect(window.capacityState).toBe('available');
    expect(window.confidence).toBe('integrated');
    expect(window.syncState).toBe('current');
  });

  it('marks ROVIQ-native one-unit capacity as limited', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_2',
      mode: 'roviq_native',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      capacityUnits: 1,
    });

    expect(window.capacityState).toBe('limited');
    expect(window.confidence).toBe('roviq_native');
  });

  it('blocks paused bridge/manual capacity', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_3',
      mode: 'bridge',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      paused: true,
    });

    expect(window.capacityState).toBe('blocked');
    expect(window.syncState).toBe('manual');
  });

  it('rejects invalid time windows', () => {
    expect(() => normalizeCapacitySignal({
      partnerLocationId: 'loc_4',
      mode: 'native_integration',
      windowStart: '2026-09-04T19:00:00.000Z',
      windowEnd: '2026-09-04T18:00:00.000Z',
    })).toThrow('capacity window must end after it starts');
  });
});
