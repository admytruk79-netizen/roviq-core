import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

// Audit logging is a side effect, never the reason a request exists. Every one of its ~45 call
// sites across the codebase awaits this directly after a primary write has already succeeded, so
// letting a transient failure here (e.g. a dropped Postgres connection) propagate turns a
// successful operation into a 500 for the caller -- as seen twice in production (offer accept in
// partners.ts, offer creation in admin.ts). Swallow it here, once, instead of guarding every
// call site individually.
export async function audit(principal: Principal, action: string, objectType: string, objectId: string, ruleBasis?: string, metadata: unknown = {}) {
  try {
    await pool.query(
      `insert into audit_log(principal_role, principal_actor_id, action, object_type, object_id, rule_basis, metadata)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [principal.role, principal.actorId ?? null, action, objectType, objectId, ruleBasis ?? null, JSON.stringify(metadata)]
    );
  } catch (error) {
    console.error('audit_log_insert_failed', { action, objectType, objectId, message: error instanceof Error ? error.message : String(error) });
  }
}
