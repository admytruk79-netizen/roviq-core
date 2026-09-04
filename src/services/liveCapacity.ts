export type PartnerOperatingMode = 'native_integration' | 'roviq_native' | 'bridge';

export type CapacityState = 'available' | 'limited' | 'blocked' | 'reserved' | 'full' | 'unknown';
export type CapacityConfidence = 'integrated' | 'roviq_native' | 'manual_verified' | 'declared' | 'stale' | 'unknown';
export type SyncState = 'current' | 'stale' | 'degraded' | 'manual' | 'failed';

export interface ExternalCapacitySignal {
  partnerLocationId: string;
  sourceConnectionId?: string | null;
  mode: PartnerOperatingMode;
  externalResourceId?: string | null;
  resourceType?: string | null;
  serviceCategory?: string | null;
  windowStart: string | Date;
  windowEnd: string | Date;
  capacityUnits?: number | null;
  blocked?: boolean | null;
  limited?: boolean | null;
  paused?: boolean | null;
  lastSuccessfulSyncAt?: string | Date | null;
  importedAt?: string | Date | null;
  manuallyVerified?: boolean | null;
  constraintSummary?: Record<string, unknown> | null;
}

export interface NormalizedCapacityWindow {
  partnerLocationId: string;
  sourceConnectionId: string | null;
  resourceExternalId: string | null;
  resourceType: string | null;
  serviceCategory: string | null;
  windowStart: Date;
  windowEnd: Date;
  capacityUnits: number;
  capacityState: CapacityState;
  confidence: CapacityConfidence;
  syncState: SyncState;
  constraintSummary: Record<string, unknown>;
}

export function normalizeCapacitySignal(signal: ExternalCapacitySignal, now = new Date()): NormalizedCapacityWindow {
  const windowStart = toDate(signal.windowStart, 'windowStart');
  const windowEnd = toDate(signal.windowEnd, 'windowEnd');

  if (windowEnd <= windowStart) {
    throw new Error('capacity window must end after it starts');
  }

  const parsedCapacityUnits = Number(signal.capacityUnits ?? 1);
  if (!Number.isFinite(parsedCapacityUnits) || !Number.isInteger(parsedCapacityUnits) || parsedCapacityUnits < 0) {
    throw new Error('capacityUnits must be a non-negative finite integer');
  }
  const capacityUnits = parsedCapacityUnits;
  const syncState = resolveSyncState(signal, now);
  const capacityState = resolveCapacityState(signal, capacityUnits, syncState);

  return {
    partnerLocationId: signal.partnerLocationId,
    sourceConnectionId: signal.sourceConnectionId ?? null,
    resourceExternalId: signal.externalResourceId ?? null,
    resourceType: signal.resourceType ?? null,
    serviceCategory: signal.serviceCategory ?? null,
    windowStart,
    windowEnd,
    capacityUnits,
    capacityState,
    confidence: resolveConfidence(signal, syncState),
    syncState,
    constraintSummary: signal.constraintSummary ?? {},
  };
}

function resolveCapacityState(signal: ExternalCapacitySignal, capacityUnits: number, syncState: SyncState): CapacityState {
  if (syncState === 'failed') return 'unknown';
  if (signal.paused || signal.blocked) return 'blocked';
  if (capacityUnits === 0) return 'full';
  if (signal.limited || capacityUnits === 1) return 'limited';
  return 'available';
}

function resolveConfidence(signal: ExternalCapacitySignal, syncState: SyncState): CapacityConfidence {
  if (syncState === 'failed' || syncState === 'degraded') return 'unknown';
  if (syncState === 'stale') return 'stale';
  if (signal.mode === 'native_integration') return 'integrated';
  if (signal.mode === 'roviq_native') return 'roviq_native';
  if (syncState === 'manual' && signal.manuallyVerified === true) return 'manual_verified';
  return 'declared';
}

function resolveSyncState(signal: ExternalCapacitySignal, now: Date): SyncState {
  const maxCurrentAgeMs = 15 * 60 * 1000;
  const maxStaleAgeMs = 60 * 60 * 1000;

  if (signal.mode === 'bridge') {
    const importedAt = signal.importedAt ? toDate(signal.importedAt, 'importedAt') : null;
    if (!importedAt) return 'degraded';
    const ageMs = Math.max(0, now.getTime() - importedAt.getTime());
    if (ageMs <= maxCurrentAgeMs) return signal.manuallyVerified === true ? 'manual' : 'current';
    if (ageMs <= maxStaleAgeMs) return 'stale';
    return 'degraded';
  }

  const lastSuccess = signal.lastSuccessfulSyncAt ? toDate(signal.lastSuccessfulSyncAt, 'lastSuccessfulSyncAt') : null;
  if (!lastSuccess) return signal.mode === 'roviq_native' ? 'current' : 'degraded';
  const ageMs = now.getTime() - lastSuccess.getTime();
  if (ageMs < 0) return 'current';
  if (ageMs <= maxCurrentAgeMs) return 'current';
  if (ageMs <= maxStaleAgeMs) return 'stale';
  return 'degraded';
}

function toDate(value: string | Date, fieldName: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}
