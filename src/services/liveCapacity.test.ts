import { describe, expect, it } from 'vitest';
import { normalizeCapacitySignal } from './liveCapacity.js';

describe('normalizeCapacitySignal', () => {
  const now = new Date('2026-09-04T18:00:00.000Z');

  it('normalizes native integration signals as integrated current capacity', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_1',
      mode: 'native_integration',
      serviceCategory: 'alignment',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      capacityUnits: 2,
      lastSuccessfulSyncAt: '2026-09-04T17:55:00.000Z',
    }, now);

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
    }, now);

    expect(window.capacityState).toBe('limited');
    expect(window.confidence).toBe('roviq_native');
  });

  it('treats a fresh manually verified bridge import as manual_verified', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_3',
      mode: 'bridge',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      importedAt: '2026-09-04T17:55:00.000Z',
      manuallyVerified: true,
    }, now);

    expect(window.syncState).toBe('manual');
    expect(window.confidence).toBe('manual_verified');
  });

  it('treats a fresh unverified bridge import as declared rather than verified', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_4',
      mode: 'bridge',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      importedAt: '2026-09-04T17:55:00.000Z',
    }, now);

    expect(window.syncState).toBe('current');
    expect(window.confidence).toBe('declared');
  });

  it('ages bridge imports to stale', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_5',
      mode: 'bridge',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      importedAt: '2026-09-04T17:30:00.000Z',
      manuallyVerified: true,
    }, now);

    expect(window.syncState).toBe('stale');
    expect(window.confidence).toBe('stale');
  });

  it('ages old bridge imports to degraded and removes confidence', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_6',
      mode: 'bridge',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      importedAt: '2026-09-04T16:00:00.000Z',
      manuallyVerified: true,
    }, now);

    expect(window.syncState).toBe('degraded');
    expect(window.confidence).toBe('unknown');
  });

  it('blocks paused bridge capacity while preserving fresh manual sync state', () => {
    const window = normalizeCapacitySignal({
      partnerLocationId: 'loc_7',
      mode: 'bridge',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      importedAt: '2026-09-04T17:55:00.000Z',
      manuallyVerified: true,
      paused: true,
    }, now);

    expect(window.capacityState).toBe('blocked');
    expect(window.syncState).toBe('manual');
  });

  it('rejects invalid time windows', () => {
    expect(() => normalizeCapacitySignal({
      partnerLocationId: 'loc_8',
      mode: 'native_integration',
      windowStart: '2026-09-04T19:00:00.000Z',
      windowEnd: '2026-09-04T18:00:00.000Z',
    }, now)).toThrow('capacity window must end after it starts');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])('rejects invalid capacityUnits %s', (capacityUnits) => {
    expect(() => normalizeCapacitySignal({
      partnerLocationId: 'loc_invalid',
      mode: 'roviq_native',
      windowStart: '2026-09-04T18:00:00.000Z',
      windowEnd: '2026-09-04T19:00:00.000Z',
      capacityUnits,
    }, now)).toThrow('capacityUnits must be a non-negative finite integer');
  });
});
