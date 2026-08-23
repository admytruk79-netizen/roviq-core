import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

export async function audit(principal: Principal, action: string, objectType: string, objectId: string, ruleBasis?: string, metadata: unknown = {}) {
  await pool.query(
    `insert into audit_log(principal_role, principal_actor_id, action, object_type, object_id, rule_basis, metadata)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [principal.role, principal.actorId ?? null, action, objectType, objectId, ruleBasis ?? null, JSON.stringify(metadata)]
  );
}
