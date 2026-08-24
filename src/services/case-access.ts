import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { principalCanAccessCase, type CaseAccessRecord } from './case-access-policy.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function loadCaseForPrincipal(principal:Principal, caseId:string, queryable:Queryable = pool) {
  const result = await queryable.query<CaseAccessRecord & Record<string,unknown>>(
    `select c.*,
       exists(select 1 from matches_offers mo where mo.case_id=c.id and mo.actor_id=$2) as has_provider_relation,
       exists(select 1 from transport_dispatches td where td.case_id=c.id and td.provider_actor_id=$2) as has_transport_relation,
       exists(select 1 from parts_orders po where po.case_id=c.id and po.supplier_actor_id=$2) as has_parts_relation,
       exists(select 1 from mobility_allocations ma where ma.case_id=c.id and ma.provider_actor_id=$2) as has_mobility_relation
     from service_cases c where c.id=$1`,
    [caseId, principal.actorId ?? null]
  );
  if (!result.rowCount) return null;
  const record = result.rows[0];
  if (!principalCanAccessCase(principal,record)) throw new Error('forbidden');
  return record;
}

export async function assertCaseAccess(principal:Principal, caseId:string, queryable:Queryable = pool) {
  const record = await loadCaseForPrincipal(principal,caseId,queryable);
  if (!record) throw new Error('case_not_found');
  return record;
}
