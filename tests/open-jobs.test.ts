import { describe, expect, it } from 'vitest';
import { rankJob, releaseDelaySeconds, standingFrom } from '../src/services/open-jobs.js';

// The job and technician ranks behind the open job board: better technicians see better jobs first.

const now = new Date('2026-06-01T00:00:00Z');

describe('job rank', () => {
  it('ranks a recent premium car with a complex fault as premium', () => {
    const r = rankJob({ year: 2025, make: 'BMW', model: 'X5', demandType: 'check_engine_light', urgency: 'normal', now });
    expect(r).toMatchObject({ rank: 'premium', score: 70 });
    expect(r.reasons).toEqual(['Premium make', 'Recent model', 'Complex diagnosis']);
  });

  it('ranks a late-model heavy-duty truck as standard and an old economy car as basic', () => {
    expect(rankJob({ year: 2021, make: 'Ford', model: 'F-250 Super Duty', demandType: 'battery', now })).toMatchObject({ rank: 'standard', score: 30 });
    expect(rankJob({ year: 2009, make: 'Toyota', model: 'Corolla', demandType: 'oil_change', urgency: 'normal', now })).toMatchObject({ rank: 'basic', score: 0 });
  });

  it('counts EVs, AWD and urgency, and caps the score at 100', () => {
    expect(rankJob({ year: 2015, make: 'Nissan', model: 'Leaf', fuelType: 'electric', urgency: 'emergency', now })).toMatchObject({ rank: 'standard', score: 35 });
    expect(rankJob({ year: 2026, make: 'Porsche', model: 'Cayenne', fuelType: 'plug_in_hybrid', drivetrain: 'awd', demandType: 'transmission', urgency: 'emergency', now }).score).toBe(100);
    expect(rankJob({ now }).rank).toBe('basic');
  });
});

describe('head start for better-ranked technicians', () => {
  it('shows premium jobs to gold first, then silver, then bronze', () => {
    expect([releaseDelaySeconds('premium', 'gold'), releaseDelaySeconds('premium', 'silver'), releaseDelaySeconds('premium', 'bronze')]).toEqual([0, 120, 300]);
    expect([releaseDelaySeconds('standard', 'gold'), releaseDelaySeconds('standard', 'silver'), releaseDelaySeconds('standard', 'bronze')]).toEqual([0, 45, 120]);
    expect(releaseDelaySeconds('basic', 'bronze')).toBe(0);
  });

  it('halves the head start in an emergency', () => {
    expect(releaseDelaySeconds('premium', 'bronze', 'emergency')).toBe(150);
  });
});

describe('technician rank', () => {
  it('starts a new technician at silver', () => {
    expect(standingFrom(0, 0, 0, 0)).toMatchObject({ tier: 'silver', score: 71, ratingAverage: null, completionRate: null });
  });

  it('promotes a well-rated, experienced technician to gold', () => {
    expect(standingFrom(4.9 * 30, 30, 25, 26).tier).toBe('gold');
  });

  it('drops a poorly rated technician who abandons jobs to bronze', () => {
    expect(standingFrom(2 * 10, 10, 3, 12)).toMatchObject({ tier: 'bronze', ratingAverage: 2, completionRate: 0.25 });
  });
});
