import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent } from './orchestration.js';

export type SelectionMode = 'customer_choice' | 'dealer_controlled' | 'auto_dispatch' | 'ops_override';

function canSelect(principal: Principal, mode: SelectionMode, relationshipOwnerActorId?: string | null) {
  if (principal.role === 'admin') return true;
  if (mode === 'customer_choice') return principal.role === 'customer';
  if (mode === 'dealer_controlled') return principal.role === 'partner' && !!principal.actorId && principal.actorId === relationshipOwnerActorId;
  // Auto-dispatch is a Core/system authority. Human principals do not impersonate it.
  return false;
}

export async function recordRecommendation(caseId: string, actorId: string | null, routingDecisionId?: string | null, client?: PoolClient) {
  const db = client ?? pool;
  await db.query(
    `update service_cases set recommended_actor_id=$1,updated_at=now() where id=$2`,
    [actorId,caseId]
  );
  if (actorId) {
    await db.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'PROVIDER_RECOMMENDED',$2)`,
      [caseId,JSON.stringify({actorId,routingDecisionId:routingDecisionId ?? null})]
    );
  }
}

export async function selectCaseActor(principal: Principal, caseId: string, actorId: string, rationale: Record<string,unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const c = await client.query(
      `select id,selection_mode,relationship_owner_actor_id,recommended_actor_id from service_cases where id=$1 for update`,
      [caseId]
    );
    if (!c.rowCount) throw new Error('case_not_found');
    const row = c.rows[0];
    const mode = row.selection_mode as SelectionMode;
    if (!canSelect(principal,mode,row.relationship_owner_actor_id)) throw new Error('selection_forbidden');

    const eligible = await client.query(
      `select 1 from routing_decisions
       where demand_id=(select demand_id from service_cases where id=$1)
         and eligible_actor_ids @> to_jsonb(array[$2::uuid]::uuid[])
       order by evaluated_at desc limit 1`,
      [caseId,actorId]
    );
    if (!eligible.rowCount && mode !== 'ops_override') throw new Error('actor_not_eligible');

    await client.query(
      `update service_cases set selected_actor_id=$1,selection_source=$2,selected_at=now(),updated_at=now() where id=$3`,
      [actorId,mode,caseId]
    );
    await client.query(
      `insert into case_selections(case_id,recommended_actor_id,selected_actor_id,selection_mode,authority_role,authority_actor_id,rationale)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [caseId,row.recommended_actor_id ?? null,actorId,mode,principal.role,principal.actorId ?? null,JSON.stringify(rationale)]
    );
    await client.query('commit');
    await appendCaseEvent(caseId,'PROVIDER_SELECTED',principal,{actorId,selectionMode:mode,...rationale});
    return {caseId,selectedActorId:actorId,selectionMode:mode};
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function autoDispatchCase(caseId: string, actorId: string, routingDecisionId: string | null, rationale: Record<string,unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const c = await client.query(`select selection_mode,recommended_actor_id from service_cases where id=$1 for update`,[caseId]);
    if (!c.rowCount) throw new Error('case_not_found');
    if (c.rows[0].selection_mode !== 'auto_dispatch') throw new Error('auto_dispatch_not_authorized');
    await client.query(
      `update service_cases set selected_actor_id=$1,selection_source='auto_dispatch',selected_at=now(),updated_at=now() where id=$2`,
      [actorId,caseId]
    );
    await client.query(
      `insert into case_selections(case_id,recommended_actor_id,selected_actor_id,selection_mode,authority_role,routing_decision_id,rationale)
       values($1,$2,$3,'auto_dispatch','system',$4,$5)`,
      [caseId,c.rows[0].recommended_actor_id ?? null,actorId,routingDecisionId,JSON.stringify(rationale)]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'PROVIDER_AUTO_DISPATCHED',$2)`,
      [caseId,JSON.stringify({actorId,routingDecisionId,...rationale})]
    );
    await client.query('commit');
    return {caseId,selectedActorId:actorId,selectionMode:'auto_dispatch' as const};
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
