import { describe, expect, it } from 'vitest';
import { principalCanAccessCase, type CaseAccessRecord } from '../src/services/case-access-policy.js';

const base:CaseAccessRecord = {
  id:'case-1', customer_actor_id:'customer-1', current_owner_actor_id:null,
  has_provider_relation:false, has_transport_relation:false,
  has_parts_relation:false, has_mobility_relation:false
};

describe('case access policy', () => {
  it('allows only the owning customer', () => {
    expect(principalCanAccessCase({role:'customer',actorId:'customer-1'},base)).toBe(true);
    expect(principalCanAccessCase({role:'customer',actorId:'customer-2'},base)).toBe(false);
  });

  it('fails closed for unassigned operational actors', () => {
    expect(principalCanAccessCase({role:'partner',actorId:'shop-1'},base)).toBe(false);
    expect(principalCanAccessCase({role:'tow',actorId:'tow-1'},base)).toBe(false);
    expect(principalCanAccessCase({role:'parts',actorId:'supplier-1'},base)).toBe(false);
    expect(principalCanAccessCase({role:'fleet',actorId:'fleet-1'},base)).toBe(false);
  });

  it('grants access only through the role-specific case relation', () => {
    expect(principalCanAccessCase({role:'partner',actorId:'shop-1'},{...base,has_provider_relation:true})).toBe(true);
    expect(principalCanAccessCase({role:'tow',actorId:'tow-1'},{...base,has_transport_relation:true})).toBe(true);
    expect(principalCanAccessCase({role:'parts',actorId:'supplier-1'},{...base,has_parts_relation:true})).toBe(true);
    expect(principalCanAccessCase({role:'fleet',actorId:'fleet-1'},{...base,has_mobility_relation:true})).toBe(true);
    expect(principalCanAccessCase({role:'tow',actorId:'tow-1'},{...base,has_provider_relation:true})).toBe(false);
  });

  it('allows network administrators without an actor id', () => {
    expect(principalCanAccessCase({role:'admin'},base)).toBe(true);
  });
});
