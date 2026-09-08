import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';
import { syncOperationalConstraints } from './case-constraint-projection.js';
import { evaluateServiceability, type ServiceabilityConstraint } from './serviceability.js';
import { assertShopPrincipalScope } from './shop-os-scope.js';

type Queryable=Pick<PoolClient,'query'>;
export type ShopOsAppointmentStatus='held'|'confirmed'|'in_progress'|'completed'|'cancelled'|'no_show'|'released';
export type ShopOsAppointmentAction='confirm'|'start'|'complete'|'cancel'|'release'|'no_show'|'reschedule';

const transitionMap:Record<Exclude<ShopOsAppointmentAction,'reschedule'>,Record<string,ShopOsAppointmentStatus>>={
  confirm:{held:'confirmed'},
  start:{confirmed:'in_progress'},
  complete:{in_progress:'completed'},
  cancel:{held:'cancelled',confirmed:'cancelled',in_progress:'cancelled'},
  release:{held:'released',confirmed:'released'},
  no_show:{held:'no_show',confirmed:'no_show'}
};

export function nextShopOsAppointmentStatus(current:ShopOsAppointmentStatus,action:ShopOsAppointmentAction):ShopOsAppointmentStatus{
  if(action==='reschedule'){
    if(!['held','confirmed'].includes(current)) throw new Error('appointment_not_reschedulable');
    return current;
  }
  const next=transitionMap[action][current];
  if(!next) throw new Error('appointment_transition_invalid');
  return next;
}

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

function assertInterval(startsAt:string|Date,endsAt:string|Date){
  const startMs=new Date(startsAt).getTime();
  const endMs=new Date(endsAt).getTime();
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs) throw httpError('appointment_interval_invalid',400);
}

async function loadManageableResource(principal:Principal,resourceId:string,db:Queryable){
  const resource=await db.query(`
    select r.*,c.id as shop_os_connection_id,c.connection_status
    from service_resources r
    join partner_system_connections c
      on c.id=r.source_connection_id
     and c.mode='roviq_native'
     and c.connection_status='active'
    where r.id=$1 and r.active=true
      and r.operational_state not in ('blocked','offline')
    limit 1`,[resourceId]);
  if(!resource.rowCount) throw httpError('shop_os_resource_not_found',404);
  const row=resource.rows[0];
  await assertShopPrincipalScope(principal,row.organization_id,row.location_id,db);
  return row;
}

async function loadExistingResource(principal:Principal,resourceId:string,db:Queryable){
  const resource=await db.query(`
    select r.*,c.id as shop_os_connection_id,c.connection_status
    from service_resources r
    left join partner_system_connections c
      on c.id=r.source_connection_id and c.mode='roviq_native'
    where r.id=$1
    limit 1`,[resourceId]);
  if(!resource.rowCount) throw httpError('shop_os_resource_not_found',404);
  const row=resource.rows[0];
  await assertShopPrincipalScope(principal,row.organization_id,row.location_id,db);
  return row;
}

async function assertManageableServiceCase(principal:Principal,serviceCaseId:string|null|undefined,organizationId:string,db:Queryable){
  if(!serviceCaseId)return;
  try{
    await assertCaseAccess(principal,serviceCaseId,db);
  }catch(error){
    if(error instanceof Error&&error.message==='case_not_found') throw httpError('service_case_not_found',404);
    if(error instanceof Error&&error.message==='forbidden') throw httpError('forbidden',403);
    throw error;
  }
  const linked=await db.query(`
    select (
      exists(
        select 1 from service_cases sc
        join actors owner on owner.id=sc.current_owner_actor_id
        where sc.id=$1 and owner.organization_id=$2
      )
      or exists(
        select 1 from service_cases sc
        join actors selected on selected.id=sc.selected_actor_id
        where sc.id=$1 and selected.organization_id=$2
      )
      or exists(
        select 1 from matches_offers mo
        join actors provider on provider.id=mo.actor_id
        where mo.case_id=$1 and mo.outcome='accepted' and provider.organization_id=$2
      )
    ) as linked`,[serviceCaseId,organizationId]);
  if(!linked.rows[0]?.linked) throw httpError('service_case_tenant_mismatch',409);
}

async function assertConfirmableServiceCase(serviceCaseId:string|null|undefined,db:Queryable){
  if(!serviceCaseId)return;
  await syncOperationalConstraints(serviceCaseId,db);
  const projected=await db.query(`select constraint_type,status,details from case_constraints where service_case_id=$1`,[serviceCaseId]);
  const constraints:ServiceabilityConstraint[]=projected.rows.map((row:any)=>({
    type:row.constraint_type,
    status:row.status,
    required:true,
    details:row.details??{}
  }));
  const decision=evaluateServiceability({
    capacity:{capacityState:'available',confidence:'roviq_native',syncState:'current',capacityUnits:1},
    constraints,
    requirementsProjected:true,
    allowManualVerified:false,
    allowStaleHold:false
  });
  if(!decision.confirmable) throw httpError('service_case_not_confirmable',409);
}

async function lockSchedulingResources(resourceIds:string[],db:Queryable){
  const ids=[...new Set(resourceIds)].sort();
  if(!ids.length)return;
  await db.query(`select id from service_resources where id=any($1::uuid[]) order by id for update`,[ids]);
}

type CapacityMatch={id:string;nominal_capacity_units:number;service_category:string|null;window_start:string|Date;window_end:string|Date};

async function peakConcurrentAppointments(input:{resourceId:string;startsAt:string|Date;endsAt:string|Date;excludeAppointmentId?:string|null},db:Queryable){
  const result=await db.query(`
    with overlapping as (
      select starts_at,ends_at
      from roviq_appointments
      where resource_id=$1
        and appointment_status in ('held','confirmed','in_progress')
        and starts_at<$3::timestamptz
        and ends_at>$2::timestamptz
        and ($4::uuid is null or id<>$4::uuid)
    ), events as (
      select greatest(starts_at,$2::timestamptz) as at,1::int as delta from overlapping
      union all
      select least(ends_at,$3::timestamptz) as at,-1::int as delta from overlapping
    ), grouped as (
      select at,sum(delta)::int as delta from events group by at
    ), running as (
      select sum(delta) over(order by at rows unbounded preceding)::int as concurrent from grouped
    )
    select coalesce(max(concurrent),0)::int as units from running`,[
    input.resourceId,input.startsAt,input.endsAt,input.excludeAppointmentId??null
  ]);
  return Number(result.rows[0]?.units??0);
}

async function assertUsableShopOsCapacity(input:{
  resourceId:string;
  sourceConnectionId:string;
  startsAt:string|Date;
  endsAt:string|Date;
  serviceCategory?:string|null;
  serviceCaseId?:string|null;
  excludeAppointmentId?:string|null;
},db:Queryable):Promise<CapacityMatch>{
  assertInterval(input.startsAt,input.endsAt);

  const locked=await db.query(`select id from service_resources where id=$1 for update`,[input.resourceId]);
  if(!locked.rowCount) throw httpError('shop_os_resource_not_found',404);

  const windows=await db.query(`
    select cw.id,cw.nominal_capacity_units,cw.service_category,cw.window_start,cw.window_end
    from capacity_windows cw
    join partner_system_connections c
      on c.id=cw.source_connection_id
     and c.mode='roviq_native'
     and c.connection_status='active'
    where cw.resource_id=$1
      and cw.source_connection_id=$2
      and cw.window_start<=$3::timestamptz
      and cw.window_end>=$4::timestamptz
      and cw.sync_state='current'
      and cw.confidence='roviq_native'
      and cw.capacity_state not in ('blocked','unknown')
      and (
        cw.service_category is null
        or ($5::text is not null and cw.service_category=$5)
      )
    order by (cw.service_category=$5) desc nulls last,cw.window_start desc,cw.window_end asc
    for update`,[
    input.resourceId,input.sourceConnectionId,input.startsAt,input.endsAt,input.serviceCategory??null
  ]);
  if(!windows.rowCount) throw httpError('shop_os_capacity_unavailable',409);

  const used=await peakConcurrentAppointments({
    resourceId:input.resourceId,startsAt:input.startsAt,endsAt:input.endsAt,excludeAppointmentId:input.excludeAppointmentId
  },db);

  for(const window of windows.rows){
    const nominal=Number(window.nominal_capacity_units??0);
    if(!Number.isFinite(nominal)||nominal<=0) continue;

    await db.query(`update capacity_reservations
      set state='expired',updated_at=now()
      where capacity_window_id=$1 and state='held' and expires_at<=now()`,[window.id]);

    const heldReservations=await db.query(`
      select coalesce(sum(units),0)::int as units
      from capacity_reservations
      where capacity_window_id=$1
        and state='held'
        and expires_at>now()
        and ($2::uuid is null or service_case_id<>$2::uuid)`,[
      window.id,input.serviceCaseId??null
    ]);
    const reserved=Number(heldReservations.rows[0]?.units??0);
    if(Number.isFinite(used)&&Number.isFinite(reserved)&&used+reserved<nominal) return window as CapacityMatch;
  }
  throw httpError('shop_os_capacity_unavailable',409);
}

async function consumeMatchingCaseReservation(serviceCaseId:string|null|undefined,capacityWindowId:string,db:Queryable){
  if(!serviceCaseId)return;
  await db.query(`update capacity_reservations
    set state='consumed',consumed_at=coalesce(consumed_at,now()),updated_at=now()
    where service_case_id=$1
      and capacity_window_id=$2
      and state='held'
      and expires_at>now()`,[serviceCaseId,capacityWindowId]);
  await db.query(`update capacity_reservations
    set state='released',released_at=coalesce(released_at,now()),updated_at=now()
    where service_case_id=$1
      and capacity_window_id<>$2
      and state='held'`,[serviceCaseId,capacityWindowId]);
}

export async function rebuildShopOsCapacity(resourceId:string,db:Queryable){
  await db.query(`
    with window_events as (
      select cw.id,greatest(a.starts_at,cw.window_start) as at,1::int as delta
      from capacity_windows cw
      join roviq_appointments a
        on a.resource_id=cw.resource_id
       and a.appointment_status in ('held','confirmed','in_progress')
       and a.starts_at<cw.window_end and a.ends_at>cw.window_start
      where cw.resource_id=$1
      union all
      select cw.id,least(a.ends_at,cw.window_end) as at,-1::int as delta
      from capacity_windows cw
      join roviq_appointments a
        on a.resource_id=cw.resource_id
       and a.appointment_status in ('held','confirmed','in_progress')
       and a.starts_at<cw.window_end and a.ends_at>cw.window_start
      where cw.resource_id=$1
    ), grouped as (
      select id,at,sum(delta)::int as delta from window_events group by id,at
    ), running as (
      select id,sum(delta) over(partition by id order by at rows unbounded preceding)::int as concurrent
      from grouped
    ), peaks as (
      select id,coalesce(max(concurrent),0)::int as peak from running group by id
    ), recalculated as (
      select cw.id,cw.nominal_capacity_units,
        greatest(cw.nominal_capacity_units-coalesce(p.peak,0),0)::int as available_units
      from capacity_windows cw
      join partner_system_connections c on c.id=cw.source_connection_id and c.mode='roviq_native'
      left join peaks p on p.id=cw.id
      where cw.resource_id=$1
    )
    update capacity_windows cw
       set capacity_units=r.available_units,
           capacity_state=case
             when cw.capacity_state in ('blocked','unknown') then cw.capacity_state
             when cw.sync_state<>'current' then cw.capacity_state
             when r.available_units<=0 then 'full'
             when r.available_units<r.nominal_capacity_units then 'limited'
             else 'available'
           end,
           updated_at=now()
      from recalculated r
     where cw.id=r.id`,[resourceId]);
}

async function appendAppointmentEvents(db:Queryable,row:any,eventType:string,principal:Principal,payload:Record<string,unknown>={}){
  if(row.service_case_id){
    await db.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
      values('service_case',$1,$2,$3,$4)`,[
      row.service_case_id,eventType,principal.actorId??null,JSON.stringify({appointmentId:row.id,resourceId:row.resource_id,status:row.appointment_status,...payload})
    ]);
  }
  if(row.source_connection_id){
    await db.query(`insert into integration_sync_events(connection_id,event_type,direction,status,roviq_entity_type,roviq_entity_id,payload)
      values($1,$2,'internal','accepted','appointment',$3,$4)`,[
      row.source_connection_id,eventType.toLowerCase(),row.id,JSON.stringify({serviceCaseId:row.service_case_id??null,resourceId:row.resource_id,status:row.appointment_status,...payload})
    ]);
  }
}

function rethrowSchedulingError(error:unknown):never{
  if((error as {code?:string})?.code==='23P01') throw httpError('resource_schedule_conflict',409);
  if(error instanceof Error && ['appointment_transition_invalid','appointment_not_reschedulable'].includes(error.message)) throw httpError(error.message,409);
  throw error;
}

export async function createShopOsAppointment(principal:Principal,input:{
  serviceCaseId?:string|null;resourceId:string;startsAt:string;endsAt:string;serviceCategory?:string|null;
  status?:'held'|'confirmed';customerVisibleSummary?:string|null;internalNotes?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    assertInterval(input.startsAt,input.endsAt);
    const resource=await loadManageableResource(principal,input.resourceId,client);
    await assertManageableServiceCase(principal,input.serviceCaseId,resource.organization_id,client);
    await lockSchedulingResources([input.resourceId],client);
    const capacity=await assertUsableShopOsCapacity({
      resourceId:input.resourceId,
      sourceConnectionId:resource.shop_os_connection_id,
      startsAt:input.startsAt,
      endsAt:input.endsAt,
      serviceCategory:input.serviceCategory??null,
      serviceCaseId:input.serviceCaseId??null
    },client);
    if((input.status??'held')==='confirmed') await assertConfirmableServiceCase(input.serviceCaseId,client);
    const created=await client.query(`insert into roviq_appointments(
      service_case_id,organization_id,location_id,resource_id,source_connection_id,appointment_status,
      starts_at,ends_at,service_category,customer_visible_summary,internal_notes,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,[
      input.serviceCaseId??null,resource.organization_id,resource.location_id,input.resourceId,resource.shop_os_connection_id,
      input.status??'held',input.startsAt,input.endsAt,input.serviceCategory??null,input.customerVisibleSummary??null,input.internalNotes??null,principal.actorId??null
    ]);
    const row=created.rows[0];
    await consumeMatchingCaseReservation(input.serviceCaseId,capacity.id,client);
    await rebuildShopOsCapacity(input.resourceId,client);
    await appendAppointmentEvents(client,row,row.appointment_status==='confirmed'?'SHOP_OS_APPOINTMENT_CONFIRMED':'SHOP_OS_APPOINTMENT_HELD',principal);
    await client.query('commit');
    return row;
  }catch(error){await client.query('rollback');rethrowSchedulingError(error);}finally{client.release();}
}

export async function updateShopOsAppointment(principal:Principal,appointmentId:string,input:{
  action:ShopOsAppointmentAction;startsAt?:string;endsAt?:string;resourceId?:string;reason?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const scheduleFieldsSupplied=input.startsAt!==undefined||input.endsAt!==undefined||input.resourceId!==undefined;
    if(input.action!=='reschedule'&&scheduleFieldsSupplied) throw httpError('schedule_change_requires_reschedule',400);

    const current=await client.query(`select * from roviq_appointments where id=$1 for update`,[appointmentId]);
    if(!current.rowCount) throw httpError('appointment_not_found',404);
    const existing=current.rows[0];
    const existingResource=await loadExistingResource(principal,existing.resource_id,client);
    await assertManageableServiceCase(principal,existing.service_case_id,existingResource.organization_id,client);
    const nextStatus=nextShopOsAppointmentStatus(existing.appointment_status,input.action);

    let nextResource=existingResource;
    if(input.action==='reschedule'){
      nextResource=await loadManageableResource(principal,input.resourceId??existing.resource_id,client);
    }else if(input.action==='confirm'||input.action==='start'){
      nextResource=await loadManageableResource(principal,existing.resource_id,client);
    }
    const nextResourceId=input.action==='reschedule'?(input.resourceId??existing.resource_id):existing.resource_id;
    if(existing.service_case_id) await assertManageableServiceCase(principal,existing.service_case_id,nextResource.organization_id,client);
    const nextStarts=input.action==='reschedule'?(input.startsAt??existing.starts_at):existing.starts_at;
    const nextEnds=input.action==='reschedule'?(input.endsAt??existing.ends_at):existing.ends_at;
    assertInterval(nextStarts,nextEnds);
    if(input.action==='reschedule' && (!input.startsAt&&!input.endsAt&&!input.resourceId)) throw httpError('reschedule_change_required',400);

    if(input.action==='reschedule'||input.action==='confirm'){
      await lockSchedulingResources([existing.resource_id,nextResourceId],client);
    }

    let matchedCapacity:CapacityMatch|null=null;
    if(input.action==='reschedule'||input.action==='confirm'){
      matchedCapacity=await assertUsableShopOsCapacity({
        resourceId:nextResourceId,
        sourceConnectionId:nextResource.shop_os_connection_id,
        startsAt:nextStarts,
        endsAt:nextEnds,
        serviceCategory:existing.service_category??null,
        serviceCaseId:existing.service_case_id??null,
        excludeAppointmentId:appointmentId
      },client);
    }
    if(nextStatus==='confirmed'&&(input.action==='confirm'||input.action==='reschedule')){
      await assertConfirmableServiceCase(existing.service_case_id,client);
    }

    const nextSourceConnectionId=(input.action==='reschedule'||input.action==='confirm'||input.action==='start')
      ? nextResource.shop_os_connection_id
      : existing.source_connection_id;
    const updated=await client.query(`update roviq_appointments
      set resource_id=$1,organization_id=$2,location_id=$3,source_connection_id=$4,appointment_status=$5,
          starts_at=$6,ends_at=$7,released_reason=case when $5 in ('released','cancelled','no_show') then $8 else released_reason end,
          lifecycle_version=lifecycle_version+1,updated_at=now()
      where id=$9 returning *`,[
      nextResourceId,nextResource.organization_id,nextResource.location_id,nextSourceConnectionId,nextStatus,
      nextStarts,nextEnds,input.reason??null,appointmentId
    ]);
    if(matchedCapacity) await consumeMatchingCaseReservation(existing.service_case_id,matchedCapacity.id,client);
    await rebuildShopOsCapacity(existing.resource_id,client);
    if(nextResourceId!==existing.resource_id) await rebuildShopOsCapacity(nextResourceId,client);
    const row=updated.rows[0];
    await appendAppointmentEvents(client,row,`SHOP_OS_APPOINTMENT_${input.action.toUpperCase()}`,principal,{previousStatus:existing.appointment_status});
    await client.query('commit');
    return row;
  }catch(error){await client.query('rollback');rethrowSchedulingError(error);}finally{client.release();}
}

export async function listShopOsSchedule(principal:Principal,input:{resourceId:string;from:string;to:string}){
  const client=await pool.connect();
  try{
    await loadExistingResource(principal,input.resourceId,client);
    const appointments=await client.query(`select * from roviq_appointments
      where resource_id=$1 and starts_at<$3 and ends_at>$2
      order by starts_at asc,id asc`,[input.resourceId,input.from,input.to]);
    const capacity=await client.query(`select * from capacity_windows
      where resource_id=$1 and window_start<$3 and window_end>$2
      order by window_start asc,id asc`,[input.resourceId,input.from,input.to]);
    return {appointments:appointments.rows,capacity:capacity.rows};
  }finally{client.release();}
}
