import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';
import { assertCaseAccess } from './case-access.js';
import { publishIntegrationEvent } from './integration-gateway.js';
import { consumeCaseCapacity, releaseCaseCapacity } from './capacity-reservation.js';
import { rebuildShopOsCapacity } from './shop-os.js';

export { appendCaseEvent, getCaseTimeline } from './case-events.js';
export { createDeadline, raiseException } from './workflow-support.js';
export { withIdempotency } from './idempotency.js';

export type CaseState =
  | 'intake' | 'triage' | 'diagnostic_pending' | 'diagnostic_in_progress'
  | 'tow_pending' | 'tow_in_progress' | 'provider_selection' | 'provider_pending'
  | 'repair_in_progress' | 'parts_pending' | 'payment_pending' | 'completed' | 'cancelled';

export type SelectionMode = 'customer_choice' | 'dealer_controlled' | 'auto_dispatch' | 'ops_override';

export async function createServiceCase(principal: Principal, input: {
  demandId?: string; marketId?: string; locationId?: string; priority?: string;
  drivability?: string; attributes?: Record<string, unknown>;
  originatingActorId?: string; relationshipOwnerActorId?: string; selectionMode?: SelectionMode;
}, transactionClient?:PoolClient) {
  const client = transactionClient ?? await pool.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query('begin');
    const domain = await client.query(`select id from domains where code='maintenance' limit 1`);
    if (!domain.rowCount) throw new Error('maintenance_domain_missing');
    const customerActorId = principal.role === 'customer' ? principal.actorId ?? null : null;
    const r = await client.query(
      `insert into service_cases(domain_id,demand_id,customer_actor_id,market_id,location_id,priority,drivability,attributes,
        originating_actor_id,relationship_owner_actor_id,selection_mode)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [domain.rows[0].id,input.demandId ?? null,customerActorId,input.marketId ?? null,input.locationId ?? null,
       input.priority ?? 'normal',input.drivability ?? 'unknown',JSON.stringify(input.attributes ?? {}),
       input.originatingActorId ?? null,input.relationshipOwnerActorId ?? input.originatingActorId ?? null,input.selectionMode ?? 'customer_choice']
    );
    const c = r.rows[0];
    const plan = await client.query(
      `insert into service_plans(case_id,status,current_revision,customer_summary,created_by_actor_id)
       values($1,'draft',1,'We are reviewing your vehicle concern and building the coordinated service plan.',$2) returning *`,
      [c.id,principal.actorId ?? null]
    );
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot,created_by_actor_id)
       values($1,1,'Case opened',$2,$3,$4)`,
      [plan.rows[0].id,plan.rows[0].customer_summary,JSON.stringify({state:'draft',tasks:[]}),principal.actorId ?? null]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('service_case',$1,'CASE_CREATED',$2,$3),
             ('service_case',$1,'SERVICE_PLAN_CREATED',$2,$4)`,
      [c.id,principal.actorId ?? null,
       JSON.stringify({state:c.state,priority:c.priority,originatingActorId:c.originating_actor_id,relationshipOwnerActorId:c.relationship_owner_actor_id,selectionMode:c.selection_mode}),
       JSON.stringify({servicePlanId:plan.rows[0].id,revision:1})]
    );
    await client.query(
      `insert into audit_log(principal_role,principal_actor_id,action,object_type,object_id,rule_basis,metadata)
       values($1,$2,'create_case','service_case',$3,'maintenance_case_created',$4)`,
      [principal.role,principal.actorId ?? null,c.id,JSON.stringify({servicePlanId:plan.rows[0].id,selectionMode:c.selection_mode})]
    );
    if (ownsTransaction) await client.query('commit');
    if (ownsTransaction) await publishCaseIntegrationEventSafely(c.id,'CASE_CREATED',principal,{ state:c.state, priority:c.priority });
    return c;
  } catch (error) {
    if (ownsTransaction) await client.query('rollback');
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

async function cancelLinkedShopOsAppointments(caseId:string,principal:Principal,client:PoolClient){
  const active=await client.query(`
    select id,resource_id,source_connection_id,appointment_status
    from roviq_appointments
    where service_case_id=$1 and appointment_status in ('held','confirmed')
    order by resource_id,id
    for update`,[caseId]);
  if(!active.rowCount)return;

  const previousStatusById=new Map(active.rows.map((row:any)=>[row.id,row.appointment_status]));
  const ids=active.rows.map((row:any)=>row.id);
  const cancelled=await client.query(`
    update roviq_appointments
       set appointment_status='cancelled',
           released_reason=coalesce(released_reason,'service_case_cancelled'),
           lifecycle_version=lifecycle_version+1,
           updated_at=now()
     where id=any($1::uuid[])
     returning *`,[ids]);

  for(const row of cancelled.rows){
    await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
      values('service_case',$1,'SHOP_OS_APPOINTMENT_CANCELLED_BY_CASE',$2,$3)`,[
      caseId,principal.actorId ?? null,JSON.stringify({appointmentId:row.id,resourceId:row.resource_id,previousStatus:previousStatusById.get(row.id)??null,status:'cancelled',reason:'service_case_cancelled'})
    ]);
    if(row.source_connection_id){
      await client.query(`insert into integration_sync_events(connection_id,event_type,direction,status,roviq_entity_type,roviq_entity_id,payload)
        values($1,'shop_os_appointment_cancelled_by_case','internal','accepted','appointment',$2,$3)`,[
        row.source_connection_id,row.id,JSON.stringify({serviceCaseId:caseId,resourceId:row.resource_id,status:'cancelled',reason:'service_case_cancelled'})
      ]);
    }
  }

  const resourceIds=[...new Set(cancelled.rows.map((row:any)=>row.resource_id as string))].sort();
  for(const resourceId of resourceIds) await rebuildShopOsCapacity(resourceId,client);
}

export async function transitionCase(principal: Principal, caseId: string, toState: CaseState, metadata: Record<string, unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from service_cases where id=$1 for update',[caseId]);
    if (!current.rowCount) return null;
    const c = current.rows[0];
    await assertCaseAccess(principal,caseId,client);
    if (c.state === toState) { await client.query('commit'); return c; }
    if (toState === 'cancelled') {
      if (!['admin','customer'].includes(principal.role)) throw new Error('transition_forbidden');
    } else {
      const rule = await client.query(
        'select * from case_transition_rules where from_state=$1 and to_state=$2', [c.state,toState]
      );
      if (!rule.rowCount) throw new Error('invalid_case_transition');
      if (!rule.rows[0].allowed_roles.includes(principal.role)) throw new Error('transition_forbidden');
    }
    const terminalSql = toState === 'completed' ? ', completed_at=now()' : toState === 'cancelled' ? ', cancelled_at=now()' : '';
    const updated = await client.query(
      `update service_cases set state=$1, version=version+1, updated_at=now() ${terminalSql} where id=$2 returning *`,
      [toState,caseId]
    );
    if(toState==='cancelled'){
      await releaseCaseCapacity(caseId,client);
      await cancelLinkedShopOsAppointments(caseId,principal,client);
    }
    if(toState==='completed') await consumeCaseCapacity(caseId,client);
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('service_case',$1,$2,$3,$4)`,
      [caseId,`CASE_${toState.toUpperCase()}`,principal.actorId ?? null,JSON.stringify({ from:c.state,to:toState,...metadata })]
    );
    if (toState === 'completed') {
      await client.query(
        `insert into coordination_milestones(case_id,milestone_code,billable,metadata)
         values($1,'CASE_COMPLETED',false,$2) on conflict(case_id,milestone_code) do nothing`,
        [caseId,JSON.stringify({source:'case_transition',from:c.state})]
      );
    }
    await client.query('commit');
    await audit(principal,'transition_case','service_case',caseId,`${c.state}->${toState}`,metadata);
    await publishCaseIntegrationEventSafely(caseId,`CASE_${toState.toUpperCase()}`,principal,{ from:c.state, to:toState });
    return updated.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

async function publishCaseIntegrationEventSafely(
  caseId:string,
  eventType:string,
  principal:Principal,
  payload:Record<string,unknown>
){
  try {
    await publishIntegrationEvent({
      aggregateType:'service_case',
      aggregateId:caseId,
      eventType,
      actorId:principal.actorId ?? undefined,
      payload
    });
  } catch (error) {
    console.error('integration_event_publish_failed', {
      eventType,
      caseId,
      message:error instanceof Error ? error.message : String(error)
    });
  }
}
