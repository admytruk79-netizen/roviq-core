import { describe, expect, it } from 'vitest';
import { evaluateServiceability } from './serviceability.js';

describe('evaluateServiceability', () => {
  it('confirms current trusted capacity when required constraints are satisfied', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'integrated', syncState:'current', capacityUnits:2 },
      constraints:[
        { type:'resource', status:'satisfied' },
        { type:'parts', status:'satisfied' },
        { type:'customer_time', status:'satisfied' }
      ]
    });
    expect(result).toEqual({ eligible:true, confirmable:true, holdable:true, reasons:[] });
  });

  it('fails closed when a required constraint is unknown', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'roviq_native', syncState:'current', capacityUnits:1 },
      constraints:[{ type:'parts', status:'unknown' }]
    });
    expect(result.eligible).toBe(false);
    expect(result.confirmable).toBe(false);
    expect(result.reasons).toContain('constraint_parts_unknown');
  });

  it('allows an explicit hold but not confirmation for stale capacity', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'stale', syncState:'stale', capacityUnits:2 },
      constraints:[],
      allowStaleHold:true
    });
    expect(result.eligible).toBe(true);
    expect(result.confirmable).toBe(false);
    expect(result.holdable).toBe(true);
  });

  it('rejects bridge/manual capacity unless explicitly authorized', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'limited', confidence:'manual_verified', syncState:'manual', capacityUnits:1 }
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('manual_capacity_not_authorized');
  });

  it('accepts explicitly authorized verified bridge capacity', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'limited', confidence:'manual_verified', syncState:'manual', capacityUnits:1 },
      allowManualVerified:true
    });
    expect(result.eligible).toBe(true);
    expect(result.confirmable).toBe(true);
  });

  it('rejects degraded or exhausted capacity', () => {
    const degraded = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'integrated', syncState:'degraded', capacityUnits:2 }
    });
    const exhausted = evaluateServiceability({
      capacity:{ capacityState:'full', confidence:'integrated', syncState:'current', capacityUnits:0 }
    });
    expect(degraded.eligible).toBe(false);
    expect(exhausted.eligible).toBe(false);
  });
});
