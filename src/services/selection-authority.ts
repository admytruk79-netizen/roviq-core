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

function capabilityForOverrideCase(row:{case_type?:string|null;drivability?:string|null}){
  if(row.drivability==='non_drivable') return 'tow';
  const type=String(row.case_type??'').toLowerCase();
  if(type.includes('diagnostic')) return 'diagnostics';
  if(type.includes('tow')) return 'tow';
  if(type.includes('part')) return 'parts_supply';
  return 'repair';
}

async function ensureOverrideDemand(row:{id:string;demand_id?:string|null;case_type?:string|null;drivability?:string|null;priority?:string|null;customer_actor_id?:string|null},client:PoolClient){
  if(row.demand_id) return {demandId:row.demand_id as string,capability:null as string|null};
  const capability=capabilityForOverrideCase(row);
  const created=await client.query(`
    insert into demand_requests(domain_id,requester_actor_id,demand_type,urgency,attributes,state)
    select d.id,$1,$2,$3,$4,'open'
      from domains d
     where d.code='maintenance'
     limit 1
    returning id`,[
    row.customer_actor_id??null,
    row.case_type||'repair',
    row.priority||'normal',
    JSON.stringify({source:'ops_override_selection',requiredCapability:capability,drivability:row.drivability??'unknown'})
  ]);
  if(!created.rowCount) throw new Error('maintenance_domain_missing');
  const demandId=created.rows[0].id as string;
  await client.query(`update service_cases set demand_id=$1,updated_at=now() where id=$2 and demand_id is null`,[demandId,row.id]);
  return {demandId,capability};
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

function assertSelectableCase(row:{state:string;selected_actor_id?:string|null}){
  if(row.state!=='provider_selection') throw new Error('case_not_selectable');
  if(row.selected_actor_id) throw new Error('selection_already_recorded');
}

async function closeCompetingOffers(caseId:string,selectedOfferId:string,selectedActorId:string,client:PoolClient){
  const closed=await client.query(`
    update matches_offers
       set outcome='declined',responded_at=coalesce(responded_at,now())
     where case_id=$1 and id<>$2 and outcome='offered'
     returning id,actor_id`,[caseId,selectedOfferId]);
  if(!closed.rowCount)return;
  await client.query(`insert into events(aggregate_type,aggregate_id,event_type,payload)
    values('service_case',$1,'COMPETING_PROVIDER_OFFERS_CLOSED',$2)`,[
    caseId,JSON.stringify({selectedOfferId,selectedActorId,closedOffers:closed.rows.map(row=>({offerId:row.id,actorId:row.actor_id}))})
  ]);
}

export async function authorizeExistingOfferSelection(
  principal: Principal,
  caseId:string,
  actorId:string,
  offer:any,
  client:PoolClient,
  rationale:Record<string,unknown>={}
){
  const c=await client.query(`select id,demand_id,state,selection_mode,relationship_owner_actor_id,recommended_actor_id,selected_actor_id,
    case_type,drivability,priority,customer_actor_id from service_cases where id=$1 for update`,[caseId]);
  if(!c.rowCount) throw new Error('case_not_found');
  const row=c.rows[0];
  assertSelectableCase(row);
  const mode=row.selection_mode as SelectionMode;
  if(!canSelect(principal,mode,row.relationship_owner_actor_id)) throw new Error('selection_forbidden');
  if(!row.demand_id) throw new Error('case_demand_missing');
  const {capability}=await resolveRequestedCapabilityForDemand(row.demand_id,client);
  const serviceability=await evaluateActorServiceability(caseId,actorId,capability,'confirm',client);
  if(!serviceabilityAllows('confirm',serviceability.decision)) throw new Error('actor_not_serviceable');
  try{ await reserveSelectionCapacity(caseId,serviceability,client); }
  catch(error){ if(error instanceof Error&&error.message==='capacity_no_longer_available') throw new Error('actor_not_serviceable'); throw error; }
  const updatedCase=await client.query(`update service_cases set
    selected_actor_id=$1,selection_source=$2,selected_at=now(),state='provider_pending',version=version+1,updated_at=now()
    where id=$3 and state='provider_selection' and selected_actor_id is null returning *`,[actorId,mode,caseId]);
  if(!updatedCase.rowCount) throw new Error('case_not_selectable');
  await closeCompetingOffers(caseId,offer.id,actorId,client);
  await client.query(`insert into case_selections(case_id,recommended_actor_id,selected_actor_id,selection_mode,authority_role,authority_actor_id,rationale)
    values($1,$2,$3,$4,$5,$6,$7)`,[caseId,row.recommended_actor_id??null,actorId,mode,principal.role,principal.actorId??null,
    JSON.stringify({...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}})]);
  await appendCaseEvent(caseId,'PROVIDER_SELECTED',principal,{actorId,selectionMode:mode,...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}},client);
  await appendCaseEvent(caseId,'CASE_PROVIDER_PENDING',principal,{from:'provider_selection',to:'provider_pending',offerId:offer.id,providerActorId:actorId,selectionMode:mode,source:'authorized_existing_offer'},client);
  return {case:updatedCase.rows[0],serviceability};
}

export async function selectCaseActor(principal: Principal, caseId: string, actorId: string, rationale: Record<string,unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const c = await client.query(
      `select id,demand_id,state,selection_mode,relationship_owner_actor_id,recommended_actor_id,selected_actor_id,
              case_type,drivability,priority,customer_actor_id
         from service_cases where id=$1 for update`,
      [caseId]
    );
    if (!c.rowCount) throw new Error('case_not_found');
    const row = c.rows[0];
    assertSelectableCase(row);
    const mode = row.selection_mode as SelectionMode;
    if (!canSelect(principal,mode,row.relationship_owner_actor_id)) throw new Error('selection_forbidden');

    let demandId=row.demand_id as string|null;
    let overrideCapability:string|null=null;
    if(!demandId){
      if(mode!=='ops_override'||principal.role!=='admin') throw new Error('case_demand_missing');
      const ensured=await ensureOverrideDemand(row,client);
      demandId=ensured.demandId;
      overrideCapability=ensured.capability;
    }

    if(mode!=='ops_override'){
      const eligible = await client.query(
        `select 1
           from routing_decisions
          where id=(
            select id from routing_decisions
             where demand_id=$1
             order by evaluated_at desc,id desc limit 1
          )
            and eligible_actor_ids @> to_jsonb(array[$2::uuid]::uuid[])`,
        [demandId,actorId]
      );
      if (!eligible.rowCount) throw new Error('actor_not_eligible');
    }

    const capability=overrideCapability ?? (await resolveRequestedCapabilityForDemand(demandId,client)).capability;
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

    const offerResult=await client.query(`
      select * from matches_offers
      where case_id=$1 and actor_id=$2 and outcome='offered'
      order by offered_at desc limit 1`,[caseId,actorId]);
    const offer=offerResult.rowCount
      ? offerResult.rows[0]
      : (await client.query(`insert into matches_offers(demand_id,case_id,actor_id,rank,rule_basis)
          values($1,$2,$3,1,'authorized_provider_selection') returning *`,[demandId,caseId,actorId])).rows[0];

    const updatedCase=await client.query(`update service_cases set
      selected_actor_id=$1,selection_source=$2,selected_at=now(),state='provider_pending',version=version+1,updated_at=now()
      where id=$3 and state='provider_selection' and selected_actor_id is null
      returning *`,[actorId,mode,caseId]);
    if(!updatedCase.rowCount) throw new Error('case_not_selectable');

    await closeCompetingOffers(caseId,offer.id,actorId,client);

    await client.query(
      `insert into case_selections(case_id,recommended_actor_id,selected_actor_id,selection_mode,authority_role,authority_actor_id,rationale)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [caseId,row.recommended_actor_id ?? null,actorId,mode,principal.role,principal.actorId ?? null,JSON.stringify({...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}})]
    );
    await appendCaseEvent(caseId,'PROVIDER_SELECTED',principal,{actorId,selectionMode:mode,...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}},client);
    await appendCaseEvent(caseId,'CASE_PROVIDER_PENDING',principal,{from:'provider_selection',to:'provider_pending',offerId:offer.id,providerActorId:actorId,selectionMode:mode,source:'authorized_provider_selection'},client);
    await client.query('commit');
    return {caseId,selectedActorId:actorId,selectionMode:mode,serviceability:serviceability.decision,offer,case:updatedCase.rows[0]};
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function autoDispatchCase(caseId: string, actorId: string, routingDecisionId: string | null, rationale: Record<string,unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const c = await client.query(`select demand_id,state,selection_mode,recommended_actor_id,selected_actor_id from service_cases where id=$1 for update`,[caseId]);
    if (!c.rowCount) throw new Error('case_not_found');
    assertSelectableCase(c.rows[0]);
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

    const updated=await client.query(
      `update service_cases
          set selected_actor_id=$1,selection_source='auto_dispatch',selected_at=now(),state='provider_pending',version=version+1,updated_at=now()
        where id=$2 and state='provider_selection' and selected_actor_id is null
        returning *`,
      [actorId,caseId]
    );
    if(!updated.rowCount) throw new Error('case_not_selectable');
    await client.query(
      `insert into case_selections(case_id,recommended_actor_id,selected_actor_id,selection_mode,authority_role,routing_decision_id,rationale)
       values($1,$2,$3,'auto_dispatch','system',$4,$5)`,
      [caseId,c.rows[0].recommended_actor_id ?? null,actorId,routingDecisionId,JSON.stringify({...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}})]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'PROVIDER_AUTO_DISPATCHED',$2),
             ('service_case',$1,'CASE_PROVIDER_PENDING',$3)`,
      [caseId,
       JSON.stringify({actorId,routingDecisionId,...rationale,serviceability:{serviceCategory:capability,capacitySource:serviceability.source,capacityWindowId:serviceability.capacityWindowId,capacityUnits:serviceability.capacityUnits}}),
       JSON.stringify({from:'provider_selection',to:'provider_pending',providerActorId:actorId,selectionMode:'auto_dispatch',routingDecisionId})]
    );
    await client.query('commit');
    return {caseId,selectedActorId:actorId,selectionMode:'auto_dispatch' as const,serviceability:serviceability.decision};
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
