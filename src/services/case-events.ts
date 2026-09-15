import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

import { validIdentityId } from './audit.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function appendCaseEvent(
  caseId: string,
  eventType: string,
  principal: Principal,
  payload: Record<string, unknown> = {},
  queryable: Queryable = pool
) {
  await queryable.query(
    `insert into events(aggregate_type,aggregate_id,event_type,actor_id,principal_identity_id,payload)
     values('service_case',$1,$2,$3,$4,$5)`,
    [caseId,eventType,principal.actorId ?? null,validIdentityId(principal.identityId),JSON.stringify(payload)]
  );
}

export async function getCaseTimeline(caseId: string) {
  const result = await pool.query(
    `select id,event_type,actor_id,occurred_at,payload
       from events
      where aggregate_type='service_case' and aggregate_id=$1
      order by occurred_at asc`,
    [caseId]
  );
  return result.rows;
}
