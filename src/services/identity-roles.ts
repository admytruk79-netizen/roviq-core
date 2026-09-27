import { pool } from '../db/pool.js';
import type { RoviqRole } from '../types/principal.js';

export type IdentityRole = { role: RoviqRole; actorId?: string; primary: boolean };

/**
 * Every workspace role an active identity may sign in as: its primary role plus each active grant
 * whose actor is still active. Each role carries its own actor, so switching roles never widens
 * what the other roles can reach.
 */
export async function listIdentityRoles(identityId: string): Promise<IdentityRole[]> {
  const r = await pool.query(
    `select pi.role, pi.actor_id, true as primary_role
       from principal_identities pi
       left join actors a on a.id=pi.actor_id
      where pi.id=$1 and pi.active=true and (pi.role='admin' or a.status='active')
     union all
     select g.role, g.actor_id, false
       from identity_role_grants g
       join principal_identities pi on pi.id=g.identity_id and pi.active=true
       join actors a on a.id=g.actor_id and a.status='active'
      where g.identity_id=$1 and g.active=true`,
    [identityId]
  );
  return r.rows
    .map((row) => ({ role: row.role as RoviqRole, actorId: row.actor_id ?? undefined, primary: row.primary_role === true }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
}

/** Whether an active identity currently holds `role` through `actorId` (primary role or active grant). */
export async function identityHoldsRole(identityId: string, role: RoviqRole, actorId?: string) {
  const roles = await listIdentityRoles(identityId);
  return roles.some((r) => r.role === role && (r.actorId ?? undefined) === (actorId ?? undefined));
}
