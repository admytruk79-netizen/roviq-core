import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent } from './orchestration.js';
import { resolveRequestedCapabilityForDemand } from './case-intelligence.js';
import { evaluateActorServiceability, serviceabilityAllows } from './serviceability-gate.js';
import { reserveCanonicalCapacity } from './capacity-reservation.js';

export type SelectionMode = 'customer_choice' | 'dealer_controlled' | 'auto_dispatch' | 'ops_override';

function canSelect(principal: Principal, mode: SelectionMode, relationshipOwnerActorId?: string | null) {
  if (principal.role === 'admin') return true;
  if (mode === 'customer_choice') return principal.role === 'customer';
  if (mode === 'dealer_controlled') return principal.role === 'partner' && !!principal.actorId && principal.actorId === relationshipOwnerActorId;
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

async function reserveSelectionCapacity(caseId:string,serviceability:{source:string;capacityWindowId:string|null},client:PoolClient){
  if(serviceability.source!=='canonical_capacity'||!serviceability.capacityWindowId) return;
  await reserveCanonicalCapacity(caseId,serviceability.capacityWindowId,client,1);
}

export async function selectCaseActor(principal: Principal, caseId: string, actorId: string, rationale: Record<string,unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const c = await client.query(
      `select id,demand_id,selection_mode,relationship_owner_actor_id,recommended_actor_id from service_cases where id=$1 for update`,
      [caseId]
    );
    if (!c.rowCount) throw new Error('case_not_found');
    const row = c.rows[0];
    const mode = row.selection_mode as SelectionMode;
    if (!canSelect(principal,mode,row.relationship_owner_actor_id)) throw new Error('selection_forbidden');
    if (!row.demand_id) throw new Error('case_demand_missing');

    const eligible = await client.query(
      `select 1 from routing_decisions
       where demand_id=$1
         and eligible_actor_ids @> to_jsonb(array[$2::uuid]::uuid[])
       order by evaluated_at desc limit 1`,
      [row.demand_id,actorId]
    );
    if (!eligible.rowCount && mode !== 'ops_override') throw new Error('actor_not_eligible');

    const {capability}=await resolveRequestedCapabilityForDemand(row.demand_id,client);
    const serviceability=await evaluateActorServiceability(caseId,actorId,capability,'confirm',client);
    if(!serviceabilityAllows('confirm',serviceability.decision)) {
      const error=new Error('actor_not_serviceable');
      (error as Error & {reasons?:string[]}).reasons=serviceability.decision.reasons;
      throw error;
    }

    try {
      await reserveSelectionCapacity(caseId,serviceability,client);
    } catch(error){
      if(error instanceof Error && error.message==='capacity_no_longer_available'){
        const conflict=new Error('actor_not_serviceable');
        (conflict as Error & {reasons?:string[]}).reasons=['capacity_exhausted'];
        throw conflict;
      }
      throw error;
    }

    await client.query(
      `update service_cases set selected_actor_id=$1,selection_source=$2,selected_at=now(),updated_at=now() where id=$3`,
      [actorId,mode,caseId]
    );
    await client.query(
      `insert into case_selections(case_id,recommended_actor_id,selected_actor_id,selection_mode,authority_role,authority_actor_id,rationale)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [caseId,row.recommended_actor_id ?? null,actorId,mode,principal.role,principal.actorId ?? null,JSON.stringify({...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}})]
    );
    await appendCaseEvent(caseId,'PROVIDER_SELECTED',principal,{actorId,selectionMode:mode,...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}},client);
    await client.query('commit');
    return {caseId,selectedActorId:actorId,selectionMode:mode,serviceability:serviceability.decision};
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function autoDispatchCase(caseId: string, actorId: string, routingDecisionId: string | null, rationale: Record<string,unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const c = await client.query(`select demand_id,selection_mode,recommended_actor_id from service_cases where id=$1 for update`,[caseId]);
    if (!c.rowCount) throw new Error('case_not_found');
    if (c.rows[0].selection_mode !== 'auto_dispatch') throw new Error('auto_dispatch_not_authorized');
    if (!c.rows[0].demand_id) throw new Error('case_demand_missing');

    const {capability}=await resolveRequestedCapabilityForDemand(c.rows[0].demand_id,client);
    const serviceability=await evaluateActorServiceability(caseId,actorId,capability,'confirm',client);
    if(!serviceabilityAllows('confirm',serviceability.decision)) throw new Error('actor_not_serviceable');

    try {
      await reserveSelectionCapacity(caseId,serviceability,client);
    } catch(error){
      if(error instanceof Error && error.message==='capacity_no_longer_available') throw new Error('actor_not_serviceable');
      throw error;
    }

    await client.query(
      `update service_cases set selected_actor_id=$1,selection_source='auto_dispatch',selected_at=now(),updated_at=now() where id=$2`,
      [actorId,caseId]
    );
    await client.query(
      `insert into case_selections(case_id,recommended_actor_id,selected_actor_id,selection_mode,authority_role,routing_decision_id,rationale)
       values($1,$2,$3,'auto_dispatch','system',$4,$5)`,
      [caseId,c.rows[0].recommended_actor_id ?? null,actorId,routingDecisionId,JSON.stringify({...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}})]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'PROVIDER_AUTO_DISPATCHED',$2)`,
      [caseId,JSON.stringify({actorId,routingDecisionId,...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}})]
    );
    await client.query('commit');
    return {caseId,selectedActorId:actorId,selectionMode:'auto_dispatch' as const,serviceability:serviceability.decision};
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
