import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent, createDeadline } from './orchestration.js';
import { audit } from './audit.js';
import { queueNotification, setCustomerSnapshot } from './operations.js';

export async function createMobilityResource(principal: Principal, input: {
  actorId: string; resourceType: string; externalReference?: string; label?: string;
  locationId?: string; attributes?: Record<string,unknown>; availableFrom?: string; availableUntil?: string;
}) {
  const r = await pool.query(
    `insert into mobility_resources(actor_id,resource_type,external_reference,label,location_id,attributes,available_from,available_until)
     values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [input.actorId,input.resourceType,input.externalReference ?? null,input.label ?? null,input.locationId ?? null,JSON.stringify(input.attributes ?? {}),input.availableFrom ?? null,input.availableUntil ?? null]
  );
  await audit(principal,'create_mobility_resource','mobility_resource',r.rows[0].id,'mobility_resource_created',{ actorId:input.actorId, resourceType:input.resourceType });
  return r.rows[0];
}

export async function requestMobility(principal: Principal, caseId: string, input:{ allocationType:string; notes?:string; metadata?:Record<string,unknown>; returnDueAt?:string }) {
  const c = await pool.query('select * from service_cases where id=$1',[caseId]);
  if (!c.rowCount) return null;
  const customerActorId = c.rows[0].customer_actor_id;
  if (principal.role === 'customer' && customerActorId !== principal.actorId) throw new Error('forbidden');
  const r = await pool.query(
    `insert into mobility_allocations(case_id,customer_actor_id,allocation_type,return_due_at,notes,metadata)
     values($1,$2,$3,$4,$5,$6) returning *`,
    [caseId,customerActorId,input.allocationType,input.returnDueAt ?? null,input.notes ?? null,JSON.stringify(input.metadata ?? {})]
  );
  await appendCaseEvent(caseId,'MOBILITY_REQUESTED',principal,{ allocationId:r.rows[0].id, allocationType:input.allocationType });
  await setCustomerSnapshot(caseId,'mobility_requested','Replacement mobility is being arranged.','Await mobility assignment');
  await audit(principal,'request_mobility','mobility_allocation',r.rows[0].id,'mobility_requested',{ caseId });
  return r.rows[0];
}

export async function assignMobility(principal: Principal, allocationId:string, input:{ providerActorId:string; resourceId?:string; returnDueAt?:string }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const a = await client.query('select * from mobility_allocations where id=$1 for update',[allocationId]);
    if (!a.rowCount) { await client.query('rollback'); return null; }
    if (!['requested','reserved'].includes(a.rows[0].state)) throw new Error('invalid_allocation_state');
    if (input.resourceId) {
      const resource = await client.query('select * from mobility_resources where id=$1 for update',[input.resourceId]);
      if (!resource.rowCount) throw new Error('resource_not_found');
      if (resource.rows[0].actor_id !== input.providerActorId) throw new Error('resource_provider_mismatch');
      if (resource.rows[0].status !== 'available') throw new Error('resource_unavailable');
      await client.query("update mobility_resources set status='assigned',updated_at=now() where id=$1",[input.resourceId]);
    }
    const updated = await client.query(
      `update mobility_allocations set provider_actor_id=$1,resource_id=$2,state='assigned',assigned_at=now(),return_due_at=coalesce($3,return_due_at),updated_at=now() where id=$4 returning *`,
      [input.providerActorId,input.resourceId ?? null,input.returnDueAt ?? null,allocationId]
    );
    await client.query('commit');
    const row = updated.rows[0];
    await appendCaseEvent(row.case_id,'MOBILITY_ASSIGNED',principal,{ allocationId, providerActorId:input.providerActorId, resourceId:input.resourceId ?? null });
    await setCustomerSnapshot(row.case_id,'mobility_assigned','Replacement mobility has been assigned.','Complete mobility handoff',row.return_due_at ?? undefined);
    if (row.customer_actor_id) await queueNotification({ caseId:row.case_id,channel:'push',recipientType:'actor',recipientId:row.customer_actor_id,templateKey:'mobility_assigned',payload:{ allocationId } });
    await createDeadline(row.case_id,'mobility_handoff',new Date(Date.now()+30*60*1000).toISOString(),'escalate_mobility_handoff',{ allocationId });
    await audit(principal,'assign_mobility','mobility_allocation',allocationId,'mobility_assigned',{ providerActorId:input.providerActorId, resourceId:input.resourceId ?? null });
    return row;
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    throw e;
  } finally { client.release(); }
}

export async function updateMobilityState(principal: Principal, allocationId:string, state:string) {
  const allowed:Record<string,string[]> = {
    assigned:['active','declined','cancelled','failed'],
    active:['return_pending','completed','failed'],
    return_pending:['completed','failed'],
    requested:['cancelled','declined','failed'],
    reserved:['assigned','cancelled','failed']
  };
  const client = await pool.connect();
  try {
    await client.query('begin');
    const a = await client.query('select * from mobility_allocations where id=$1 for update',[allocationId]);
    if (!a.rowCount) { await client.query('rollback'); return null; }
    const current = a.rows[0];
    if (!(allowed[current.state] ?? []).includes(state)) throw new Error('invalid_allocation_transition');
    const timestamps = state === 'active' ? ',activated_at=now()' : state === 'return_pending' ? '' : state === 'completed' ? ',completed_at=now(),returned_at=coalesce(returned_at,now())' : state === 'cancelled' ? ',cancelled_at=now()' : '';
    const updated = await client.query(`update mobility_allocations set state=$1,updated_at=now() ${timestamps} where id=$2 returning *`,[state,allocationId]);
    if (['completed','cancelled','declined','failed'].includes(state) && current.resource_id) {
      await client.query("update mobility_resources set status='available',updated_at=now() where id=$1",[current.resource_id]);
    }
    await client.query('commit');
    const row = updated.rows[0];
    await appendCaseEvent(row.case_id,`MOBILITY_${state.toUpperCase()}`,principal,{ allocationId });
    if (state === 'active') await setCustomerSnapshot(row.case_id,'mobility_active','Replacement mobility is active.','Continue service journey',row.return_due_at ?? undefined);
    if (state === 'completed') await setCustomerSnapshot(row.case_id,'mobility_completed','Replacement mobility has been returned.','Continue service journey');
    await audit(principal,'update_mobility_state','mobility_allocation',allocationId,`${current.state}->${state}`);
    return row;
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    throw e;
  } finally { client.release(); }
}

export async function listMobilityForCase(caseId:string) {
  const r = await pool.query(`select ma.*,mr.resource_type,mr.label,mr.external_reference from mobility_allocations ma left join mobility_resources mr on mr.id=ma.resource_id where ma.case_id=$1 order by ma.created_at desc`,[caseId]);
  return r.rows;
}
