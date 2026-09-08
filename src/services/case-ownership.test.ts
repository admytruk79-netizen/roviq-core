import { describe, expect, it } from 'vitest';
import { deriveCaseOwnership } from './case-ownership.js';

describe('deriveCaseOwnership',()=>{
  it('customer owns intake',()=>{
    expect(deriveCaseOwnership({state:'intake',customerActorId:'customer-1'})).toEqual({role:'customer',actorId:'customer-1'});
  });

  it('entering diagnostic work clears stale actor ownership',()=>{
    expect(deriveCaseOwnership({state:'diagnostic_pending',currentOwnerRole:'admin',currentOwnerActorId:'admin-1'})).toEqual({role:'diagnostic',actorId:null});
  });

  it('assigned diagnostic remains owner while diagnostic work advances',()=>{
    expect(deriveCaseOwnership({state:'diagnostic_in_progress',currentOwnerRole:'diagnostic',currentOwnerActorId:'diagnostic-1'})).toEqual({role:'diagnostic',actorId:'diagnostic-1'});
  });

  it('entering tow work clears stale actor ownership',()=>{
    expect(deriveCaseOwnership({state:'tow_pending',currentOwnerRole:'diagnostic',currentOwnerActorId:'diagnostic-1'})).toEqual({role:'tow',actorId:null});
  });

  it('assigned tow provider remains owner while tow work advances',()=>{
    expect(deriveCaseOwnership({state:'tow_in_progress',currentOwnerRole:'tow',currentOwnerActorId:'tow-1'})).toEqual({role:'tow',actorId:'tow-1'});
  });

  it('selected provider owns provider and repair states',()=>{
    expect(deriveCaseOwnership({state:'provider_pending',selectedActorId:'shop-1'})).toEqual({role:'partner',actorId:'shop-1'});
    expect(deriveCaseOwnership({state:'repair_in_progress',selectedActorId:'shop-1'})).toEqual({role:'partner',actorId:'shop-1'});
  });

  it('parts owns parts pending and terminal cases have no owner',()=>{
    expect(deriveCaseOwnership({state:'parts_pending'})).toEqual({role:'parts',actorId:null});
    expect(deriveCaseOwnership({state:'completed',selectedActorId:'shop-1'})).toEqual({role:null,actorId:null});
    expect(deriveCaseOwnership({state:'cancelled',customerActorId:'customer-1'})).toEqual({role:null,actorId:null});
  });
});
