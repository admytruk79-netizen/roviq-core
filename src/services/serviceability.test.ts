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
      ],
      requirementsProjected:true
    });
    expect(result).toEqual({ eligible:true, confirmable:true, holdable:true, reasons:[] });
  });

  it('fails closed when a caller has not projected applicable requirements', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'integrated', syncState:'current', capacityUnits:2 },
      constraints:[]
    });
    expect(result.eligible).toBe(false);
    expect(result.confirmable).toBe(false);
    expect(result.reasons).toContain('requirements_not_projected');
  });

  it('fails closed when a required constraint is unknown', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'roviq_native', syncState:'current', capacityUnits:1 },
      constraints:[{ type:'parts', status:'unknown' }],
      requirementsProjected:true
    });
    expect(result.eligible).toBe(false);
    expect(result.confirmable).toBe(false);
    expect(result.reasons).toContain('constraint_parts_unknown');
  });

  it('allows an explicit hold but not confirmation for stale capacity', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'stale', syncState:'stale', capacityUnits:2 },
      constraints:[],
      requirementsProjected:true,
      allowStaleHold:true
    });
    expect(result.eligible).toBe(true);
    expect(result.confirmable).toBe(false);
    expect(result.holdable).toBe(true);
  });

  it('rejects bridge/manual capacity unless explicitly authorized', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'limited', confidence:'manual_verified', syncState:'manual', capacityUnits:1 },
      requirementsProjected:true
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('manual_capacity_not_authorized');
  });

  it('accepts explicitly authorized verified bridge capacity', () => {
    const result = evaluateServiceability({
      capacity:{ capacityState:'limited', confidence:'manual_verified', syncState:'manual', capacityUnits:1 },
      requirementsProjected:true,
      allowManualVerified:true
    });
    expect(result.eligible).toBe(true);
    expect(result.confirmable).toBe(true);
  });

  it('rejects degraded, exhausted, or generically reserved capacity', () => {
    const degraded = evaluateServiceability({
      capacity:{ capacityState:'available', confidence:'integrated', syncState:'degraded', capacityUnits:2 },
      requirementsProjected:true
    });
    const exhausted = evaluateServiceability({
      capacity:{ capacityState:'full', confidence:'integrated', syncState:'current', capacityUnits:0 },
      requirementsProjected:true
    });
    const reserved = evaluateServiceability({
      capacity:{ capacityState:'reserved', confidence:'roviq_native', syncState:'current', capacityUnits:1 },
      requirementsProjected:true
    });
    expect(degraded.eligible).toBe(false);
    expect(exhausted.eligible).toBe(false);
    expect(reserved.confirmable).toBe(false);
    expect(reserved.reasons).toContain('capacity_reserved');
  });
});
