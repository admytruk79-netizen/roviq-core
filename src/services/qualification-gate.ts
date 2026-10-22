import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { loadActorQualifications } from './serviceability-gate.js';

// One place every assignment path asks "may this actor take this case?" for the case's
// qualification requirements (MACRE). Routing and provider selection already go through
// evaluateActorServiceability; direct Ops offers, offer acceptance and open-job claims come here.
// A case with no registered requirements is never blocked. A mandatory requirement without
// current verified evidence always is.

type Queryable = Pick<PoolClient, 'query'>;

export class QualificationBlockedError extends Error {
  constructor(public reasons: string[]) {
    super('qualification_blocked');
  }
}

/** Mandatory requirements this actor does not meet for this case, as `kind:key:reason`. */
export async function qualificationBlockingReasons(caseId: string, actorId: string, db: Queryable = pool, at?: Date) {
  // Write callers pass their transaction client after locking the case. Evidence reviews
  // take FOR UPDATE on this same actor, so the proof read cannot race their commit.
  // The default pool is for advisory/read-only checks and must not take a transient lock.
  if (db !== pool) await db.query('select id from actors where id=$1 for share /* qualification_write_guard */', [actorId]);
  return (await loadActorQualifications(caseId, actorId, db, at ?? new Date())).blockingReasons;
}

export async function assertQualified(caseId: string | null | undefined, actorId: string, db: Queryable = pool, at?: Date) {
  if (!caseId) return;
  const reasons = await qualificationBlockingReasons(caseId, actorId, db, at);
  if (reasons.length) throw new QualificationBlockedError(reasons);
}

/** Of these cases, the ones that have qualification requirements registered. */
export async function casesWithRequirements(caseIds: string[], db: Queryable = pool) {
  if (!caseIds.length) return new Set<string>();
  const r = await db.query('select distinct service_case_id from case_qualification_requirements where service_case_id = any($1::uuid[])', [caseIds]);
  return new Set<string>(r.rows.map((row) => row.service_case_id));
}
