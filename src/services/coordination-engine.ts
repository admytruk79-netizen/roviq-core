export const COORDINATION_ENGINE_VERSION = '1.0.0';

export type CoordinationSignals = {
  capacity?: number | null;
  rating?: number | null;
  onTime?: number | null;
  distanceMiles?: number | null;
  etaMinutes?: number | null;
  continuity?: number | null;
};

export type CoordinationCandidate = {
  actorId: string;
  signals: CoordinationSignals;
};

export type CoordinationPolicy = {
  weights?: Record<string, number>;
  defaults?: Record<string, number>;
  limits?: Record<string, number>;
  coordination?: {
    enabled?: boolean;
    maxAdjustment?: number;
    continuityBoost?: number;
    balanceBoost?: number;
    spatialBoost?: number;
    reliabilityBoost?: number;
  };
};

export type CoordinationRelationship =
  | 'fit'
  | 'proximity'
  | 'continuity'
  | 'balance'
  | 'reliability'
  | 'counterweight';

export type RankedCoordinationCandidate = CoordinationCandidate & {
  score: number;
  baseScore: number;
  adjustment: number;
  relationships: CoordinationRelationship[];
  rank: number;
  engineVersion: string;
};

/**
 * ROVIQ Coordination Engine
 *
 * The design intentionally borrows only general engine principles from the
 * ASCEND Resonance work: deterministic evaluation, bounded adjustments,
 * relationship signals, fairness/counterweight, reproducibility and a
 * diagnostic trace. It does not copy domain content or spiritual semantics.
 *
 * Routing policy remains authoritative. The engine adds a bounded coordination
 * layer around the policy score and never turns an ineligible actor into an
 * eligible one.
 */
export function rankCoordinationCandidates(
  candidates: CoordinationCandidate[],
  policy: CoordinationPolicy,
  seed: string
): RankedCoordinationCandidate[] {
  const enabled = policy.coordination?.enabled !== false;
  const maxAdjustment = clamp(policy.coordination?.maxAdjustment ?? 0.12, 0, 0.25);

  const rows = candidates.map((candidate) => {
    const baseScore = scoreWithPolicy(candidate.signals, policy);
    const relationships = relationshipSignals(candidate, candidates);
    const adjustment = enabled
      ? boundedAdjustment(candidate, relationships, policy, maxAdjustment)
      : 0;
    const score = round(baseScore * (1 + adjustment));
    return {
      ...candidate,
      score,
      baseScore: round(baseScore),
      adjustment: round(adjustment),
      relationships,
      rank: 0,
      engineVersion: COORDINATION_ENGINE_VERSION,
      tie: deterministicTie(seed, candidate.actorId)
    };
  });

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
    return a.tie - b.tie;
  });

  return rows.map(({ tie: _tie, ...row }, index) => ({ ...row, rank: index + 1 }));
}

function scoreWithPolicy(signals: CoordinationSignals, policy: CoordinationPolicy) {
  const weights = policy.weights ?? {};
  const defaults = policy.defaults ?? {};
  let score = 0;
  for (const [signal, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight)) continue;
    const raw = signals[signal as keyof CoordinationSignals];
    const fallback = defaults[signal] ?? 0;
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    score += value * weight;
  }
  return score;
}

function relationshipSignals(candidate: CoordinationCandidate, all: CoordinationCandidate[]): CoordinationRelationship[] {
  const out = new Set<CoordinationRelationship>();
  const s = candidate.signals;

  if (finite(s.capacity) && Number(s.capacity) > 0) out.add('fit');
  if (finite(s.distanceMiles) || finite(s.etaMinutes)) out.add('proximity');
  if (finite(s.continuity) && Number(s.continuity) > 0) out.add('continuity');
  if ((finite(s.rating) && Number(s.rating) >= 4) || (finite(s.onTime) && Number(s.onTime) >= 0.9)) out.add('reliability');

  const capacities = all.map(x => x.signals.capacity).filter(finite).map(Number);
  if (capacities.length > 1 && finite(s.capacity)) {
    const mean = capacities.reduce((sum, x) => sum + x, 0) / capacities.length;
    if (Number(s.capacity) >= mean) out.add('balance');
    const minimum = Math.min(...capacities);
    if (Number(s.capacity) > minimum) out.add('counterweight');
  }

  return [...out];
}

function boundedAdjustment(
  candidate: CoordinationCandidate,
  relationships: CoordinationRelationship[],
  policy: CoordinationPolicy,
  maxAdjustment: number
) {
  const cfg = policy.coordination ?? {};
  let adjustment = 0;

  if (relationships.includes('continuity')) {
    adjustment += clamp(cfg.continuityBoost ?? 0.035, 0, 0.08);
  }
  if (relationships.includes('balance') || relationships.includes('counterweight')) {
    adjustment += clamp(cfg.balanceBoost ?? 0.025, 0, 0.06);
  }
  if (relationships.includes('reliability')) {
    adjustment += clamp(cfg.reliabilityBoost ?? 0.025, 0, 0.06);
  }
  if (relationships.includes('proximity')) {
    const distance = candidate.signals.distanceMiles;
    const eta = candidate.signals.etaMinutes;
    const spatialQuality = finite(eta)
      ? 1 / (1 + Math.max(0, Number(eta)) / 30)
      : finite(distance)
        ? 1 / (1 + Math.max(0, Number(distance)) / 15)
        : 0;
    adjustment += clamp(cfg.spatialBoost ?? 0.04, 0, 0.08) * spatialQuality;
  }

  return clamp(adjustment, -maxAdjustment, maxAdjustment);
}

function deterministicTie(seed: string, actorId: string) {
  const text = `${seed}:${actorId}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round(value: number) {
  return Math.round(value * 10000) / 10000;
}
