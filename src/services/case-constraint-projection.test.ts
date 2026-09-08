import { describe, expect, it } from 'vitest';
import {
  deriveApprovalConstraint,
  deriveCustomerTimeConstraint,
  deriveMobilityConstraint,
  derivePartsConstraint,
  deriveTransportConstraint
} from './case-constraint-projection.js';

describe('operational constraint projection',()=>{
  it('requires the explicit ready state for every required part',()=>{
    expect(derivePartsConstraint({received:1})).toMatchObject({status:'required',total:1,ready:0});
    expect(derivePartsConstraint({ready:1})).toMatchObject({status:'satisfied',total:1,ready:1});
    expect(derivePartsConstraint({ready:1,received:1})).toMatchObject({status:'required',total:2,ready:1});
  });

  it('keeps unavailable parts blocking even when other parts are ready',()=>{
    expect(derivePartsConstraint({ready:2,unavailable:1}).status).toBe('blocked');
  });

  it('lets the newest successful mobility replacement supersede historical failures',()=>{
    const result=deriveMobilityConstraint(['reserved','failed','declined']);
    expect(result.status).toBe('satisfied');
    expect(result.currentState).toBe('reserved');
    expect(result.history).toEqual({reserved:1,failed:1,declined:1});
  });

  it('blocks when the current mobility attempt failed but retains prior success for audit',()=>{
    const result=deriveMobilityConstraint(['failed','completed']);
    expect(result.status).toBe('blocked');
    expect(result.currentState).toBe('failed');
    expect(result.history).toEqual({failed:1,completed:1});
  });

  it('requires a fresh customer time window and satisfies an active held appointment',()=>{
    const now=new Date('2026-09-05T12:00:00Z');
    expect(deriveCustomerTimeConstraint('held','2026-09-05T13:00:00Z','2026-09-05T14:00:00Z',now).status).toBe('satisfied');
    expect(deriveCustomerTimeConstraint('confirmed','2026-09-05T10:00:00Z','2026-09-05T11:00:00Z',now)).toMatchObject({status:'required',expired:true});
  });

  it('blocks rejected current approvals and satisfies only when all current approvals are approved',()=>{
    expect(deriveApprovalConstraint(['approved','approved']).status).toBe('satisfied');
    expect(deriveApprovalConstraint(['approved','pending']).status).toBe('required');
    expect(deriveApprovalConstraint(['approved','rejected']).status).toBe('blocked');
  });

  it('requires a destination and accepted transport before downstream confirmation',()=>{
    expect(deriveTransportConstraint('accepted',{}).status).toBe('required');
    expect(deriveTransportConstraint('assigned',{address:'123 Main St'}).status).toBe('required');
    expect(deriveTransportConstraint('accepted',{address:'123 Main St'})).toMatchObject({status:'satisfied',destinationReady:true});
    expect(deriveTransportConstraint('failed',{address:'123 Main St'}).status).toBe('blocked');
  });
});
