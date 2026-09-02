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

  const spatial = await pool.query('select origin,current_vehicle,destination from case_spatial_context where case_id=$1',[input.caseId]);
  const caseAttributes = c.rows[0].attributes && typeof c.rows[0].attributes === 'object' ? c.rows[0].attributes : {};
  const resolvedPickup = input.pickupLocation ?? spatial.rows[0]?.origin ?? spatial.rows[0]?.current_vehicle ?? caseAttributes.intakeLocation ?? undefined;
  const resolvedDropoff = input.dropoffLocation ?? spatial.rows[0]?.destination ?? undefined;

  const r = await pool.query(
    `insert into transport_dispatches(case_id,transport_type,pickup_location,dropoff_location,vehicle_context,eta_at,metadata)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [input.caseId,input.transportType,JSON.stringify(resolvedPickup ?? {}),JSON.stringify(resolvedDropoff ?? {}),JSON.stringify(input.vehicleContext ?? {}),input.etaAt ?? null,JSON.stringify(input.metadata ?? {})]
  );
  const dispatch = r.rows[0];

  if (resolvedPickup || resolvedDropoff) {
    await pool.query(
      `insert into case_spatial_context(case_id,origin,current_vehicle,destination,route_context,source,updated_at)
       values($1,$2::jsonb,$2::jsonb,$3::jsonb,'{}'::jsonb,'transport_dispatch',now())
       on conflict(case_id) do update set
         origin=coalesce(excluded.origin,case_spatial_context.origin),
         current_vehicle=coalesce(excluded.current_vehicle,case_spatial_context.current_vehicle),
         destination=coalesce(excluded.destination,case_spatial_context.destination),
         source='transport_dispatch',
         updated_at=now()`,
      [input.caseId,resolvedPickup ? JSON.stringify(resolvedPickup) : null,resolvedDropoff ? JSON.stringify(resolvedDropoff) : null]
    );
  }

  if (c.rows[0].state !== 'tow_pending' && c.rows[0].state !== 'tow_in_progress') {
    await transitionCase(principal,input.caseId,'tow_pending',{ transportDispatchId:dispatch.id, transportType:input.transportType });
  }

  const sideEffects = await Promise.allSettled([
    appendCaseEvent(input.caseId,'TRANSPORT_REQUESTED',principal,{ dispatchId:dispatch.id, transportType:input.transportType, pickupInherited:Boolean(!input.pickupLocation&&resolvedPickup) }),
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
  try {
    await client.query('begin');
    const d = await client.query('select * from transport_dispatches where id=$1 for update',[dispatchId]);
    if (!d.rowCount) throw new Error('dispatch_not_found');
    const current = d.rows[0];
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
    const updated = await client.query(
      `update transport_dispatches set provider_actor_id=$1,status='assigned',assigned_at=now(),eta_at=coalesce($2,eta_at),updated_at=now() where id=$3 returning *`,
      [providerActorId,etaAt ?? null,dispatchId]
    );
    await client.query(`update service_cases set current_owner_role='tow',current_owner_actor_id=$1,updated_at=now() where id=$2`,[providerActorId,current.case_id]);
    await client.query('commit');
    committed = true;

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
  } catch (e) {
    if (!committed) await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

export async function updateTransportStatus(principal: Principal, dispatchId:string, status:TransportStatus, metadata:Record<string,unknown> = {}) {
  const d = await pool.query('select * from transport_dispatches where id=$1',[dispatchId]);
  if (!d.rowCount) throw new Error('dispatch_not_found');
  const current = d.rows[0];
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
  const updated = await pool.query(`update transport_dispatches set status=$1,metadata=metadata || $2::jsonb,updated_at=now() ${ts} where id=$3 returning *`,[status,JSON.stringify(metadata),dispatchId]);
  await appendCaseEvent(current.case_id,`TRANSPORT_${status.toUpperCase()}`,principal,{ dispatchId,...metadata });
  if (status === 'accepted') {
    const c = await pool.query('select state from service_cases where id=$1',[current.case_id]);
    if (c.rows[0]?.state === 'tow_pending') await transitionCase(principal,current.case_id,'tow_in_progress',{ dispatchId });
    await setCustomerSnapshot(current.case_id,'transport_confirmed','Your transport provider has confirmed the job.','Provider is preparing for pickup',updated.rows[0].eta_at);
  } else if (status === 'en_route') {
    await setCustomerSnapshot(current.case_id,'transport_en_route','Your transport provider is on the way.','Prepare vehicle for pickup',updated.rows[0].eta_at);
  } else if (status === 'arrived') {
    await setCustomerSnapshot(current.case_id,'transport_arrived','Your transport provider has arrived.','Vehicle handoff in progress',updated.rows[0].eta_at);
  } else if (status === 'delivered') {
    await pool.query(`update workflow_deadlines set state='resolved',resolved_at=now() where case_id=$1 and deadline_type like 'transport_%' and state='open'`,[current.case_id]);
    await setCustomerSnapshot(current.case_id,'transport_delivered','Your vehicle has reached its destination.','Service journey continues');
  } else if (status === 'declined') {
    await pool.query(`update service_cases set current_owner_role=null,current_owner_actor_id=null,updated_at=now() where id=$1`,[current.case_id]);
    // Leave status='declined' (already set by the update above) rather than overwriting it back
    // to 'requested' here: assignTransportDispatch already treats 'declined' as assignable, so the
    // dispatch is reassignable either way, but callers should see the decline they just recorded.
    const released = await pool.query(
      `update transport_dispatches
       set provider_actor_id=null,assigned_at=null,accepted_at=null,updated_at=now(),metadata=metadata || $2::jsonb
       where id=$1 returning *`,
      [dispatchId,JSON.stringify({lastDeclinedBy:principal.actorId??null,lastDeclinedAt:new Date().toISOString()})]
    );
    await appendCaseEvent(current.case_id,'TRANSPORT_RELEASED_FOR_REASSIGNMENT',principal,{dispatchId,declinedProviderActorId:current.provider_actor_id});
    await setCustomerSnapshot(current.case_id,'transport_reassignment','A new transport provider is being arranged.','Reassigning transport');
    await audit(principal,'update_transport_status','transport_dispatch',dispatchId,`${current.status}->declined`,metadata);
    return released.rows[0];
  } else if (status === 'failed') {
    await pool.query(`update service_cases set current_owner_role=null,current_owner_actor_id=null,updated_at=now() where id=$1`,[current.case_id]);
    await setCustomerSnapshot(current.case_id,'transport_reassignment','A new transport provider is being arranged.','Reassigning transport');
  }
  await audit(principal,'update_transport_status','transport_dispatch',dispatchId,`${current.status}->${status}`,metadata);
  return updated.rows[0];
}

export async function getTransportDispatch(dispatchId:string) {
  const r = await pool.query('select * from transport_dispatches where id=$1',[dispatchId]);
  return r.rows[0] ?? null;
}
