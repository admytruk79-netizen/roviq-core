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
  if (['partner','diagnostic'].includes(principal.role)) return record.has_provider_relation;
  if (principal.role === 'tow') return record.has_transport_relation;
  if (principal.role === 'parts') return record.has_parts_relation;
  if (principal.role === 'fleet') return record.has_mobility_relation;
  return false;
}
