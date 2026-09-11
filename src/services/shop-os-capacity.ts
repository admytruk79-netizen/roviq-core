import { assertAppointmentInterval, httpError, type Queryable } from './shop-os-scheduling-rules.js';

export type CapacityMatch={id:string;nominal_capacity_units:number;service_category:string|null;window_start:string|Date;window_end:string|Date};

export async function lockSchedulingCase(serviceCaseId:string|null|undefined,db:Queryable){
  if(!serviceCaseId)return;
  const locked=await db.query(`select id from service_cases where id=$1 for update`,[serviceCaseId]);
  if(!locked.rowCount) throw httpError('service_case_not_found',404);
}

export async function lockSchedulingResources(resourceIds:string[],db:Queryable){
  const ids=[...new Set(resourceIds)].sort();
  if(!ids.length)return;
  await db.query(`select id from service_resources where id=any($1::uuid[]) order by id for update`,[ids]);
}

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

export async function assertUsableShopOsResource(resourceId:string,sourceConnectionId:string,db:Queryable){
  const usable=await db.query(`
    select r.id
    from service_resources r
    join partner_system_connections c
      on c.id=r.source_connection_id
     and c.id=$2
     and c.mode='roviq_native'
     and c.connection_status='active'
    where r.id=$1
      and r.source_connection_id=$2
      and r.active=true
      and r.operational_state not in ('blocked','offline')
    for update of r,c`,[resourceId,sourceConnectionId]);
  if(!usable.rowCount) throw httpError('shop_os_resource_unavailable',409);
}

export async function assertUsableShopOsCapacity(input:{
  resourceId:string;
  sourceConnectionId:string;
  startsAt:string|Date;
  endsAt:string|Date;
  serviceCategory?:string|null;
  serviceCaseId?:string|null;
  excludeAppointmentId?:string|null;
},db:Queryable):Promise<CapacityMatch>{
  assertAppointmentInterval(input.startsAt,input.endsAt);
  const locked=await db.query(`select id from service_resources where id=$1 for update`,[input.resourceId]);
  if(!locked.rowCount) throw httpError('shop_os_resource_not_found',404);
  await assertUsableShopOsResource(input.resourceId,input.sourceConnectionId,db);

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

  const used=await peakConcurrentAppointments({resourceId:input.resourceId,startsAt:input.startsAt,endsAt:input.endsAt,excludeAppointmentId:input.excludeAppointmentId},db);
  for(const window of windows.rows){
    const nominal=Number(window.nominal_capacity_units??0);
    if(!Number.isFinite(nominal)||nominal<=0) continue;
    await db.query(`update capacity_reservations set state='expired',updated_at=now() where capacity_window_id=$1 and state='held' and expires_at<=now()`,[window.id]);
    const heldReservations=await db.query(`
      select coalesce(sum(units),0)::int as units
      from capacity_reservations
      where capacity_window_id=$1
        and state='held'
        and expires_at>now()
        and ($2::uuid is null or service_case_id<>$2::uuid)`,[window.id,input.serviceCaseId??null]);
    const reserved=Number(heldReservations.rows[0]?.units??0);
    if(Number.isFinite(used)&&Number.isFinite(reserved)&&used+reserved<nominal) return window as CapacityMatch;
  }
  throw httpError('shop_os_capacity_unavailable',409);
}

export async function consumeMatchingCaseReservation(serviceCaseId:string|null|undefined,capacityWindowId:string,db:Queryable){
  if(!serviceCaseId)return;
  await db.query(`update capacity_reservations
    set state='consumed',consumed_at=coalesce(consumed_at,now()),updated_at=now()
    where service_case_id=$1 and capacity_window_id=$2 and state='held' and expires_at>now()`,[serviceCaseId,capacityWindowId]);
  await db.query(`update capacity_reservations
    set state='released',released_at=coalesce(released_at,now()),updated_at=now()
    where service_case_id=$1 and capacity_window_id<>$2 and state='held'`,[serviceCaseId,capacityWindowId]);
}

export async function rebuildShopOsCapacity(resourceId:string,db:Queryable){
  await db.query(`
    with window_events as (
      select cw.id,greatest(a.starts_at,cw.window_start) as at,1::int as delta
      from capacity_windows cw
      join roviq_appointments a on a.resource_id=cw.resource_id
       and a.appointment_status in ('held','confirmed','in_progress')
       and a.starts_at<cw.window_end and a.ends_at>cw.window_start
      where cw.resource_id=$1
      union all
      select cw.id,least(a.ends_at,cw.window_end) as at,-1::int as delta
      from capacity_windows cw
      join roviq_appointments a on a.resource_id=cw.resource_id
       and a.appointment_status in ('held','confirmed','in_progress')
       and a.starts_at<cw.window_end and a.ends_at>cw.window_start
      where cw.resource_id=$1
    ), grouped as (
      select id,at,sum(delta)::int as delta from window_events group by id,at
    ), running as (
      select id,sum(delta) over(partition by id order by at rows unbounded preceding)::int as concurrent from grouped
      from grouped
    ), peaks as (
      select id,coalesce(max(concurrent),0)::int as peak from running group by id
    ), recalculated as (
      select cw.id,cw.nominal_capacity_units,greatest(cw.nominal_capacity_units-coalesce(p.peak,0),0)::int as available_units
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
