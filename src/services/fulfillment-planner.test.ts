import { describe, expect, it } from 'vitest';
import { constraintBlockers, fulfillmentPlanStatus } from './fulfillment-planner.js';

describe('network fulfillment planning',()=>{
  it('treats required, blocked and unknown canonical constraints as blockers',()=>{
    const blockers=constraintBlockers([
      {constraint_type:'parts',status:'required',projection_key:'parts-readiness',details:{}},
      {constraint_type:'authorization',status:'blocked',projection_key:'repair-authorization',details:{}},
      {constraint_type:'mobility',status:'unknown',projection_key:'mobility-allocation',details:{}},
      {constraint_type:'approval',status:'satisfied',projection_key:'approval-state',details:{}},
      {constraint_type:'transport',status:'waived',projection_key:'transport-readiness',details:{}}
    ]);
    expect(blockers.map((b)=>b.type)).toEqual(['parts','authorization','mobility']);
  });

  it('requires at least one routed candidate and zero blockers to mark a plan feasible',()=>{
    expect(fulfillmentPlanStatus(1,[])).toBe('feasible');
    expect(fulfillmentPlanStatus(0,[])).toBe('blocked');
    expect(fulfillmentPlanStatus(2,[{type:'parts'}])).toBe('blocked');
  });
});
