import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

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

async function loadManageableResource(principal:Principal,resourceId:string,db:Queryable){
  const resource=await db.query(`
    select r.*,c.id as shop_os_connection_id,c.connection_status
    from service_resources r
    join partner_system_connections c
      on c.mode='roviq_native'
     and c.connection_status not in ('revoked','failed')
     and (
       c.location_id=r.location_id
       or (c.location_id is null and c.organization_id=r.organization_id)
     )
    where r.id=$1 and r.active=true
    order by (c.location_id is not null) desc,c.updated_at desc
    limit 1`,[resourceId]);
  if(!resource.rowCount) throw httpError('shop_os_resource_not_found',404);
  const row=resource.rows[0];
  if(principal.role==='admin') return row;
  if(principal.role!=='partner' || !principal.actorId) throw httpError('forbidden',403);
  const actor=await db.query(`select organization_id,location_id from actors where id=$1 and status='active'`,[principal.actorId]);
  if(!actor.rowCount) throw httpError('forbidden',403);
  const scope=actor.rows[0];
  if(!scope.organization_id || scope.organization_id!==row.organization_id) throw httpError('forbidden',403);
  if(scope.location_id && scope.location_id!==row.location_id) throw httpError('forbidden',403);
  return row;
}

export async function rebuildShopOsCapacity(resourceId:string,db:Queryable){
  await db.query(`
    with recalculated as (
      select cw.id,cw.nominal_capacity_units,
        greatest(cw.nominal_capacity_units-count(a.id),0)::int as available_units
      from capacity_windows cw
      join partner_system_connections c on c.id=cw.source_connection_id and c.mode='roviq_native'
      left join roviq_appointments a
        on a.resource_id=cw.resource_id
       and a.appointment_status in ('held','confirmed','in_progress')
       and a.starts_at<cw.window_end and a.ends_at>cw.window_start
      where cw.resource_id=$1
      group by cw.id,cw.nominal_capacity_units
    )
    update capacity_windows cw
       set capacity_units=r.available_units,
           capacity_state=case
             when r.available_units<=0 then 'full'
             when r.available_units<r.nominal_capacity_units then 'limited'
             else 'available'
           end,
           confidence='roviq_native',sync_state='current',updated_at=now()
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
    const resource=await loadManageableResource(principal,input.resourceId,client);
    const created=await client.query(`insert into roviq_appointments(
      service_case_id,organization_id,location_id,resource_id,source_connection_id,appointment_status,
      starts_at,ends_at,service_category,customer_visible_summary,internal_notes,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,[
      input.serviceCaseId??null,resource.organization_id,resource.location_id,input.resourceId,resource.shop_os_connection_id,
      input.status??'held',input.startsAt,input.endsAt,input.serviceCategory??null,input.customerVisibleSummary??null,input.internalNotes??null,principal.actorId??null
    ]);
    const row=created.rows[0];
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
    const current=await client.query(`select * from roviq_appointments where id=$1 for update`,[appointmentId]);
    if(!current.rowCount) throw httpError('appointment_not_found',404);
    const existing=current.rows[0];
    await loadManageableResource(principal,existing.resource_id,client);
    const nextStatus=nextShopOsAppointmentStatus(existing.appointment_status,input.action);
    const nextResourceId=input.resourceId??existing.resource_id;
    const nextResource=nextResourceId===existing.resource_id
      ? await loadManageableResource(principal,existing.resource_id,client)
      : await loadManageableResource(principal,nextResourceId,client);
    const nextStarts=input.startsAt??existing.starts_at;
    const nextEnds=input.endsAt??existing.ends_at;
    if(input.action==='reschedule' && (!input.startsAt&&!input.endsAt&&!input.resourceId)) throw httpError('reschedule_change_required',400);
    const updated=await client.query(`update roviq_appointments
      set resource_id=$1,organization_id=$2,location_id=$3,source_connection_id=$4,appointment_status=$5,
          starts_at=$6,ends_at=$7,released_reason=case when $5 in ('released','cancelled','no_show') then $8 else released_reason end,
          lifecycle_version=lifecycle_version+1,updated_at=now()
      where id=$9 returning *`,[
      nextResourceId,nextResource.organization_id,nextResource.location_id,nextResource.shop_os_connection_id,nextStatus,
      nextStarts,nextEnds,input.reason??null,appointmentId
    ]);
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
    await loadManageableResource(principal,input.resourceId,client);
    const appointments=await client.query(`select * from roviq_appointments
      where resource_id=$1 and starts_at<$3 and ends_at>$2
      order by starts_at asc,id asc`,[input.resourceId,input.from,input.to]);
    const capacity=await client.query(`select * from capacity_windows
      where resource_id=$1 and window_start<$3 and window_end>$2
      order by window_start asc,id asc`,[input.resourceId,input.from,input.to]);
    return {appointments:appointments.rows,capacity:capacity.rows};
  }finally{client.release();}
}
