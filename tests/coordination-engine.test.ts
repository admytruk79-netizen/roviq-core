import { describe, expect, it } from 'vitest';
import { COORDINATION_ENGINE_VERSION, rankCoordinationCandidates } from '../src/services/coordination-engine.js';

describe('ROVIQ coordination engine', () => {
  const policy = {
    weights: { capacity: 1, rating: 2, onTime: 4 },
    coordination: { enabled: true, maxAdjustment: 0.12 }
  };

  it('is deterministic for the same seed and inputs', () => {
    const candidates = [
      { actorId:'a', signals:{ capacity:2, rating:4.5, onTime:0.95 } },
      { actorId:'b', signals:{ capacity:2, rating:4.5, onTime:0.95 } }
    ];
    const first = rankCoordinationCandidates(candidates, policy, 'case-1');
    const second = rankCoordinationCandidates(candidates, policy, 'case-1');
    expect(first).toEqual(second);
    expect(first[0].engineVersion).toBe(COORDINATION_ENGINE_VERSION);
  });

  it('keeps adjustments bounded', () => {
    const ranked = rankCoordinationCandidates([
      { actorId:'a', signals:{ capacity:10, rating:5, onTime:1, distanceMiles:1, etaMinutes:3, continuity:1 } }
    ], {
      ...policy,
      coordination:{ enabled:true, maxAdjustment:0.05, continuityBoost:1, balanceBoost:1, spatialBoost:1, reliabilityBoost:1 }
    }, 'case-2');
    expect(ranked[0].adjustment).toBeLessThanOrEqual(0.05);
  });

  it('emits interpretable relationship signals', () => {
    const ranked = rankCoordinationCandidates([
      { actorId:'a', signals:{ capacity:4, rating:4.8, onTime:0.97, distanceMiles:4, continuity:1 } },
      { actorId:'b', signals:{ capacity:1, rating:3.7, onTime:0.7 } }
    ], policy, 'case-3');
    const byActor = Object.fromEntries(ranked.map((r) => [r.actorId, r.relationships]));
    // 'a' is above the capacity mean (2.5): gets the fairness-neutral 'balance' tag, not 'counterweight'.
    expect(byActor.a).toEqual(expect.arrayContaining(['fit','proximity','continuity','reliability','balance']));
    expect(byActor.a).not.toContain('counterweight');
    // 'b' is below the mean: it's the under-resourced candidate the fairness nudge should favor.
    expect(byActor.b).toContain('counterweight');
    expect(byActor.b).not.toContain('balance');
  });

  it('can be disabled to preserve policy-only scoring', () => {
    const ranked = rankCoordinationCandidates([
      { actorId:'a', signals:{ capacity:3, rating:4, onTime:0.9 } }
    ], {
      weights:{ capacity:1 },
      coordination:{ enabled:false }
    }, 'case-4');
    expect(ranked[0].score).toBe(3);
    expect(ranked[0].adjustment).toBe(0);
  });
});
