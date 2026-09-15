import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every admin identity has actorId=null by design, so principal.actorId alone can never say
// which admin performed an action. principal.identityId (the JWT subject) can, but a handful of
// internally-issued tokens (admin test-session helpers) carry a synthetic, non-uuid subject --
// guard against ever trying to persist one of those.
export function validIdentityId(identityId?: string) {
  return identityId && UUID_RE.test(identityId) ? identityId : null;
}

// Audit logging is a side effect, never the reason a request exists. Every one of its ~45 call
// sites across the codebase awaits this directly after a primary write has already succeeded, so
// letting a transient failure here (e.g. a dropped Postgres connection) propagate turns a
// successful operation into a 500 for the caller -- as seen twice in production (offer accept in
// partners.ts, offer creation in admin.ts). Swallow it here, once, instead of guarding every
// call site individually.
export async function audit(principal: Principal, action: string, objectType: string, objectId: string, ruleBasis?: string, metadata: unknown = {}) {
  try {
    await pool.query(
      `insert into audit_log(principal_role, principal_actor_id, principal_identity_id, action, object_type, object_id, rule_basis, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [principal.role, principal.actorId ?? null, validIdentityId(principal.identityId), action, objectType, objectId, ruleBasis ?? null, JSON.stringify(metadata)]
    );
  } catch (error) {
    console.error('audit_log_insert_failed', { action, objectType, objectId, message: error instanceof Error ? error.message : String(error) });
  }
}
