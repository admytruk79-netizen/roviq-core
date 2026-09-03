import type { Principal } from '../types/principal.js';

export type CaseAccessRecord = {
  id:string;
  customer_actor_id:string|null;
  current_owner_actor_id:string|null;
  has_provider_relation:boolean;
  has_transport_relation:boolean;
  has_parts_relation:boolean;
  has_mobility_relation:boolean;
};

export function principalCanAccessCase(principal:Principal, record:CaseAccessRecord) {
  if (principal.role === 'admin') return true;
  if (!principal.actorId) return false;
  if (principal.role === 'customer') return record.customer_actor_id === principal.actorId;
  if (record.current_owner_actor_id === principal.actorId) return true;
  // An actor's real relation to a case (an accepted offer, an assigned dispatch, a parts order,
  // a mobility allocation) is itself sufficient proof of legitimate access -- it doesn't need to
  // also match the actor's primary role. Field Response identities can hold a capability (e.g. a
  // tow-role actor granted 'diagnostics') that lets them act on a case under a relation their base
  // role wouldn't check; gating on role first silently blocked them from ever reading the case
  // they were just allowed to act on.
  return record.has_provider_relation || record.has_transport_relation || record.has_parts_relation || record.has_mobility_relation;
}
