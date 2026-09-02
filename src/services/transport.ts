import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent, createDeadline, transitionCase } from './orchestration.js';
import { audit } from './audit.js';
import { queueNotification, setCustomerSnapshot } from './operations.js';

export type TransportStatus = 'requested'|'assigned'|'accepted'|'en_route'|'arrived'|'vehicle_loaded'|'in_transit'|'delivered'|'declined'|'cancelled'|'failed';

function hasLocation(value:unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value as Record<string,unknown>).length > 0;
}

export async function createTransportDispatch(principal: Principal, input:{
  caseId:string;
  transportType:'tow'|'valet';
  pickupLocation?:Record<string,unknown>;
  dropoffLocation?:Record<string,unknown>;
  vehicleContext?:Record<string,unknown>;
  etaAt?:string;
  metadata?:Record<string,unknown>;
}) {
  const c = await pool.query('select * from service_cases where id=$1',[input.caseId]);
  if (!c.rowCount) throw new Error('case_not_found');
  const r = await pool.query(
    `insert into transport_dispatches(case_id,transport_type,pickup_location,dropoff_location,vehicle_context,eta_at,metadata)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [input.caseId,input.transportType,JSON.stringify(input.pickupLocation ?? {}),JSON.stringify(input.dropoffLocation ?? {}),JSON.stringify(input.vehicleContext ?? {}),input.etaAt ?? null,JSON.stringify(input.metadata ?? {})]
  );
  const dispatch = r.rows[0];

  if (input.pickupLocation || input.dropoffLocation) {
    await pool.query(
      `insert into case_spatial_context(case_id,origin,current_vehicle,destination,route_context,source,updated_at)
       values($1,$2::jsonb,$2::jsonb,$3::jsonb,'{}'::jsonb,'transport_dispatch',now())
       on conflict(case_id) do update set
         origin=coalesce(excluded.origin,case_spatial_context.origin),
         current_vehicle=coalesce(excluded.current_vehicle,case_spatial_context.current_vehicle),
         destination=coalesce(excluded.destination,case_spatial_context.destination),
         source='transport_dispatch',
         updated_at=now()`,
      [input.caseId,input.pickupLocation ? JSON.stringify(input.pickupLocation) : null,input.dropoffLocation ? JSON.stringify(input.dropoffLocation) : null]
    );
  }

  if (c.rows[0].state !== 'tow_pending' && c.rows[0].state !== 'tow_in_progress') {
    await transitionCase(principal,input.caseId,'tow_pending',{ transportDispatchId:dispatch.id, transportType:input.transportType });
  }

  const sideEffects = await Promise.allSettled([
    appendCaseEvent(input.caseId,'TRANSPORT_REQUESTED',principal,{ dispatchId:dispatch.id, transportType:input.transportType }),
    setCustomerSnapshot(input.caseId,'transport_requested','Vehicle transport has been requested.','Waiting for a transport provider',input.etaAt),
    createDeadline(input.caseId,'transport_assignment',new Date(Date.now()+5*60*1000).toISOString(),'escalate_transport_assignment',{ dispatchId:dispatch.id }),
    audit(principal,'create_transport_dispatch','transport_dispatch',dispatch.id,'transport_requested',{ caseId:input.caseId, transportType:input.transportType })
  ]);
  const failedSideEffects = sideEffects.filter((result) => result.status === 'rejected');
  if (failedSideEffects.length > 0) {
    console.warn('transport_creation_side_effect_failed', {
      dispatchId:dispatch.id,
      caseId:input.caseId,
      failedCount:failedSideEffects.length
    });
  }
  return dispatch;
}

export async function assignTransportDispatch(principal: Principal, dispatchId:string, providerActorId:string, etaAt?:string) {
  const client = await pool.connect();
  let committed = false;
  let current: any;
  let updated: any;
  try {
    await client.query('begin');
    const d = await client.query('select * from transport_dispatches where id=$1 for update',[dispatchId]);
    if (!d.rowCount) throw new Error('dispatch_not_found');
    current = d.rows[0];
    if (!['requested','declined','failed'].includes(current.status)) {
      if (current.provider_actor_id === providerActorId) {
        await client.query('commit');
        committed = true;
        return current;
      }
      throw new Error('dispatch_not_assignable');
    }
    const provider = await client.query(
      `select a.id,a.actor_type,coalesce(pc.tow_participation,false) as tow_participation,coalesce(pc.valet_participation,false) as valet_participation
       from actors a left join partner_controls pc on pc.actor_id=a.id where a.id=$1 and a.status='active'`,[providerActorId]
    );
    if (!provider.rowCount) throw new Error('provider_not_found');
    const allowed = current.transport_type === 'tow' ? (provider.rows[0].actor_type === 'tow' || provider.rows[0].tow_participation) : provider.rows[0].valet_participation;
    if (!allowed) throw new Error('provider_not_transport_capable');
    updated = await client.query(
      `update transport_dispatches set provider_actor_id=$1,status='assigned',assigned_at=now(),eta_at=coalesce($2,eta_at),updated_at=now() where id=$3 returning *`,
      [providerActorId,etaAt ?? null,dispatchId]
    );
    await client.query(`update service_cases set current_owner_role='tow',current_owner_actor_id=$1,updated_at=now() where id=$2`,[providerActorId,current.case_id]);
    await client.query('commit');
    committed = true;
  } catch (e) {
    if (!committed) await client.query('rollback');
    throw e;
  } finally {
    // Released before the post-commit side effects below, which each acquire their own connection
    // via the shared pool -- holding this one open through them risks the same pool-exhaustion
    // deadlock fixed in updateTransportStatus's declined branch (Devin review finding on this PR).
    client.release();
  }

  const sideEffects = await Promise.allSettled([
    appendCaseEvent(current.case_id,'TRANSPORT_ASSIGNED',principal,{ dispatchId, providerActorId, etaAt:updated.rows[0].eta_at }),
    setCustomerSnapshot(current.case_id,'transport_assigned','A transport provider has been assigned.','Provider confirmation pending',updated.rows[0].eta_at),
    queueNotification({ caseId:current.case_id, channel:'push', recipientType:'actor', recipientId:providerActorId, templateKey:'transport_assignment', payload:{ dispatchId, transportType:current.transport_type } }),
    audit(principal,'assign_transport','transport_dispatch',dispatchId,'transport_provider_assigned',{ providerActorId })
  ]);
  const failedSideEffects = sideEffects.filter((result) => result.status === 'rejected');
  if (failedSideEffects.length > 0) {
    console.warn('transport_assignment_side_effect_failed', {
      dispatchId,
      caseId:current.case_id,
      failedCount:failedSideEffects.length
    });
  }
  return updated.rows[0];
}

export async function updateTransportStatus(principal: Principal, dispatchId:string, status:TransportStatus, metadata:Record<string,unknown> = {}) {
  const client = await pool.connect();
  let committed = false;
  let current: any;
  let updated: any;
  let caseStateForTransition: string | null = null;
  try {
    await client.query('begin');
    // Row lock for the whole read-check-write sequence: without it, a decline's status write and
    // its later provider-release write are two separate statements that a concurrent
    // assignTransportDispatch (itself row-locked) can interleave between, silently wiping out a
    // newly assigned provider the moment it commits (Devin review finding on this PR).
    const d = await client.query('select * from transport_dispatches where id=$1 for update',[dispatchId]);
    if (!d.rowCount) throw new Error('dispatch_not_found');
    current = d.rows[0];
    if (principal.role !== 'admin' && current.provider_actor_id !== principal.actorId) throw new Error('dispatch_forbidden');
    const allowed:Record<string,TransportStatus[]> = {
      assigned:['accepted','declined','cancelled'],
      accepted:['en_route','cancelled','failed'],
      en_route:['arrived','failed'],
      arrived:['vehicle_loaded','in_transit','delivered','failed'],
      vehicle_loaded:['in_transit','failed'],
      in_transit:['delivered','failed']
    };
    if (!(allowed[current.status] ?? []).includes(status)) throw new Error('invalid_dispatch_transition');
    if (status === 'delivered' && !hasLocation(current.dropoff_location)) throw new Error('dropoff_location_required');
    const timestampColumn:Record<string,string> = { accepted:'accepted_at', en_route:'en_route_at', arrived:'arrived_at', delivered:'completed_at' };
    const ts = timestampColumn[status] ? `, ${timestampColumn[status]}=now()` : '';
    updated = await client.query(`update transport_dispatches set status=$1,metadata=metadata || $2::jsonb,updated_at=now() ${ts} where id=$3 returning *`,[status,JSON.stringify(metadata),dispatchId]);
    if (status === 'accepted') {
      const c = await client.query('select state from service_cases where id=$1',[current.case_id]);
      caseStateForTransition = c.rows[0]?.state ?? null;
    } else if (status === 'declined') {
      await client.query(`update service_cases set current_owner_role=null,current_owner_actor_id=null,updated_at=now() where id=$1`,[current.case_id]);
      // Leave status='declined' (already set by the update above) rather than overwriting it back
      // to 'requested' here: assignTransportDispatch already treats 'declined' as assignable, so the
      // dispatch is reassignable either way, but callers should see the decline they just recorded.
      updated = await client.query(
        `update transport_dispatches
         set provider_actor_id=null,assigned_at=null,accepted_at=null,updated_at=now(),metadata=metadata || $2::jsonb
         where id=$1 returning *`,
        [dispatchId,JSON.stringify({lastDeclinedBy:principal.actorId??null,lastDeclinedAt:new Date().toISOString()})]
      );
      // Insert directly on `client` rather than calling appendCaseEvent (which acquires its own
      // connection via the shared pool): with `client`'s connection held open for this transaction,
      // enough concurrent declines to saturate the pool would have every request holding one
      // connection while waiting on a second, deadlocking until each blocked query times out.
      await client.query(
        `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
         values('service_case',$1,'TRANSPORT_RELEASED_FOR_REASSIGNMENT',$2,$3)`,
        [current.case_id,principal.actorId??null,JSON.stringify({dispatchId,declinedProviderActorId:current.provider_actor_id})]
      );
    } else if (status === 'failed') {
      await client.query(`update service_cases set current_owner_role=null,current_owner_actor_id=null,updated_at=now() where id=$1`,[current.case_id]);
    } else if (status === 'delivered') {
      await client.query(`update workflow_deadlines set state='resolved',resolved_at=now() where case_id=$1 and deadline_type like 'transport_%' and state='open'`,[current.case_id]);
    }
    await client.query(`insert into audit_log(principal_role,principal_actor_id,action,object_type,object_id,rule_basis,metadata) values($1,$2,'update_transport_status','transport_dispatch',$3,$4,$5)`,[principal.role,principal.actorId??null,dispatchId,status==='declined'?`${current.status}->declined`:`${current.status}->${status}`,JSON.stringify(metadata)]);
    await client.query('commit');
    committed = true;
  } catch (e) {
    if (!committed) await client.query('rollback');
    throw e;
  } finally {
    // Release the transaction's connection before the post-commit side effects below, which each
    // acquire their own connection via the shared pool: holding this one open through them means
    // every one of those calls competes for the same pool this connection is still occupying,
    // which can exhaust it under load (Devin review finding on this PR).
    client.release();
  }

  // transitionCase manages its own connection/transaction and can't run inside the transaction
  // above; it must follow the commit (matches the pre-existing behavior: the case transition was
  // never atomic with the dispatch update, only ever ordered after it).
  if (caseStateForTransition === 'tow_pending') await transitionCase(principal,current.case_id,'tow_in_progress',{ dispatchId });

  const eventType = status === 'declined' ? 'TRANSPORT_DECLINED' : `TRANSPORT_${status.toUpperCase()}`;
  const sideEffects: Promise<unknown>[] = [appendCaseEvent(current.case_id,eventType,principal,{ dispatchId,...metadata })];
  if (status === 'accepted') sideEffects.push(setCustomerSnapshot(current.case_id,'transport_confirmed','Your transport provider has confirmed the job.','Provider is preparing for pickup',updated.rows[0].eta_at));
  else if (status === 'en_route') sideEffects.push(setCustomerSnapshot(current.case_id,'transport_en_route','Your transport provider is on the way.','Prepare vehicle for pickup',updated.rows[0].eta_at));
  else if (status === 'arrived') sideEffects.push(setCustomerSnapshot(current.case_id,'transport_arrived','Your transport provider has arrived.','Vehicle handoff in progress',updated.rows[0].eta_at));
  else if (status === 'delivered') sideEffects.push(setCustomerSnapshot(current.case_id,'transport_delivered','Your vehicle has reached its destination.','Service journey continues'));
  else if (status === 'declined' || status === 'failed') sideEffects.push(setCustomerSnapshot(current.case_id,'transport_reassignment','A new transport provider is being arranged.','Reassigning transport'));
  const results = await Promise.allSettled(sideEffects);
  const failedSideEffects = results.filter((r) => r.status === 'rejected');
  if (failedSideEffects.length > 0) {
    console.warn('transport_status_side_effect_failed', { dispatchId, caseId:current.case_id, status, failedCount:failedSideEffects.length });
  }
  return updated.rows[0];
}

export async function getTransportDispatch(dispatchId:string) {
  const r = await pool.query('select * from transport_dispatches where id=$1',[dispatchId]);
  return r.rows[0] ?? null;
}
