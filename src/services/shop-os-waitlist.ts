import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';
import type { ShopResourceType } from './shop-os-resources.js';

type Queryable=Pick<PoolClient,'query'>;
export type ShopWaitlistAction='offer'|'book'|'cancel'|'expire'|'requeue';

const shopResourceTypes = new Set<ShopResourceType>([
  'bay','technician','advisor','equipment','mobile_unit','tow_unit','valet_driver','loaner_vehicle'
]);

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

async function resolveScope(principal:Principal,input:{organizationId?:string;locationId?:string},db:Queryable){
  return resolveShopPrincipalScope(principal,input,db);
}

async function assertCase(principal:Principal,serviceCaseId:string|null|undefined,organizationId:string,db:Queryable){
  if(!serviceCaseId)return;
  try{ await assertCaseAccess(principal,serviceCaseId,db); }
  catch(error){
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
        select 1 from matches_offers mo
        join actors provider on provider.id=mo.actor_id
        where mo.case_id=$1 and provider.organization_id=$2
      )
    ) as linked`,[serviceCaseId,organizationId]);
  if(!linked.rows[0]?.linked) throw httpError('service_case_tenant_mismatch',409);
}

export async function createShopWaitlistEntry(principal:Principal,input:{
  organizationId?:string;
  locationId?:string;
  serviceCaseId?:string|null;
  requestedServiceCategory?:string|null;
  requestedAfter?:string|null;
  requestedBefore?:string|null;
  estimatedDurationMinutes?:number|null;
  preferredResourceTypes?:ShopResourceType[];
  priority?:number;
  notes?:string|null;
}){
  const preferences=input.preferredResourceTypes??[];
  if(preferences.some((value)=>!shopResourceTypes.has(value))) throw httpError('preferred_resource_type_invalid',400);

  const client=await pool.connect();
  try{
    await client.query('begin');
    const scope=await resolveScope(principal,input,client);
    await assertCase(principal,input.serviceCaseId,scope.organizationId,client);
    const created=await client.query(`insert into shop_waitlist_entries(
      organization_id,location_id,service_case_id,requested_service_category,requested_after,requested_before,
      estimated_duration_minutes,preferred_resource_types,priority,notes,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,[
      scope.organizationId,scope.locationId,input.serviceCaseId??null,input.requestedServiceCategory??null,
      input.requestedAfter??null,input.requestedBefore??null,input.estimatedDurationMinutes??null,
      preferences,input.priority??100,input.notes??null,principal.actorId??null
    ]);
    await client.query('commit');
    return created.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function listShopWaitlist(principal:Principal,input:{organizationId?:string;locationId?:string;states?:string[]}){
  const client=await pool.connect();
  try{
    const scope=await resolveScope(principal,input,client);
    const states=input.states?.length?input.states:['waiting','offered'];
    const result=await client.query(`select * from shop_waitlist_entries
      where organization_id=$1
        and ($2::uuid is null or location_id=$2::uuid)
        and state=any($3::text[])
      order by priority asc,created_at asc,id asc`,[scope.organizationId,scope.locationId,states]);
    return {scope,entries:result.rows};
  }finally{client.release();}
}

export async function listWaitlistAppointmentChoices(principal:Principal,entryId:string){
  const client=await pool.connect();
  try{
    const current=await client.query(`select * from shop_waitlist_entries where id=$1`,[entryId]);
    if(!current.rowCount) throw httpError('waitlist_entry_not_found',404);
    const row=current.rows[0];
    await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},client);
    await assertCase(principal,row.service_case_id,row.organization_id,client);
    const preferredResourceTypes=Array.isArray(row.preferred_resource_types)?row.preferred_resource_types.map(String):[];
    const result=await client.query(`
      select a.id,a.service_case_id,a.appointment_status,a.starts_at,a.ends_at,a.service_category,
             a.customer_visible_summary,a.resource_id,r.display_name as resource_display_name,r.resource_type
      from roviq_appointments a
      left join service_resources r on r.id=a.resource_id
      where a.organization_id=$1
        and ($2::uuid is null or a.location_id=$2::uuid)
        and a.appointment_status in ('held','confirmed')
        and a.service_case_id is not distinct from $3::uuid
        and ($4::text is null or a.service_category=$4::text)
        and ($5::timestamptz is null or a.starts_at>=$5::timestamptz)
        and ($6::timestamptz is null or a.ends_at<=$6::timestamptz)
        and ($7::int is null or extract(epoch from (a.ends_at-a.starts_at))/60 >= $7::int)
        and (cardinality($8::text[])=0 or r.resource_type=any($8::text[]))
      order by a.starts_at asc,a.id asc`,[
      row.organization_id,row.location_id,row.service_case_id,row.requested_service_category,
      row.requested_after,row.requested_before,row.estimated_duration_minutes,preferredResourceTypes
    ]);
    return {entryId,appointments:result.rows};
  }finally{client.release();}
}

export async function updateShopWaitlistEntry(principal:Principal,entryId:string,input:{
  action:ShopWaitlistAction;
  appointmentId?:string;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(`select * from shop_waitlist_entries where id=$1 for update`,[entryId]);
    if(!current.rowCount) throw httpError('waitlist_entry_not_found',404);
    const row=current.rows[0];
    await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},client);
    await assertCase(principal,row.service_case_id,row.organization_id,client);

    let nextState:string;
    let canonicalOfferExpiry:string|Date|null=null;
    if(input.action==='offer'){
      if(row.state!=='waiting') throw httpError('waitlist_transition_invalid',409);
      const expiry=await client.query(`select clock_timestamp()+interval '30 minutes' as expires_at`);
      canonicalOfferExpiry=expiry.rows[0].expires_at;
      nextState='offered';
    }else if(input.action==='book'){
      if(!['waiting','offered'].includes(row.state)) throw httpError('waitlist_transition_invalid',409);
      if(!input.appointmentId) throw httpError('appointment_id_required',400);
      if(row.state==='offered'){
        const active=await client.query(`select $1::timestamptz>clock_timestamp() as active`,[row.offer_expires_at]);
        if(!active.rows[0]?.active) throw httpError('waitlist_offer_expired',409);
      }
      const appointment=await client.query(`
        select a.id,a.organization_id,a.location_id,a.service_case_id,a.service_category,a.starts_at,a.ends_at,a.appointment_status,
               a.resource_id,r.resource_type
        from roviq_appointments a
        left join service_resources r on r.id=a.resource_id
        where a.id=$1`,[input.appointmentId]);
      if(!appointment.rowCount) throw httpError('appointment_not_found',404);
      const a=appointment.rows[0];
      if(!['held','confirmed'].includes(a.appointment_status)) throw httpError('waitlist_appointment_inactive',409);
      if(a.organization_id!==row.organization_id) throw httpError('forbidden',403);
      if(row.location_id&&a.location_id!==row.location_id) throw httpError('forbidden',403);
      if((a.service_case_id??null)!==(row.service_case_id??null)) throw httpError('waitlist_case_mismatch',409);
      if(row.requested_service_category&&a.service_category!==row.requested_service_category) throw httpError('waitlist_service_category_mismatch',409);
      const preferredResourceTypes=Array.isArray(row.preferred_resource_types)?row.preferred_resource_types.map(String):[];
      if(preferredResourceTypes.length>0&&(!a.resource_type||!preferredResourceTypes.includes(String(a.resource_type)))) {
        throw httpError('waitlist_resource_type_mismatch',409);
      }
      if(row.requested_after&&new Date(a.starts_at).getTime()<new Date(row.requested_after).getTime()) throw httpError('waitlist_time_window_mismatch',409);
      if(row.requested_before&&new Date(a.ends_at).getTime()>new Date(row.requested_before).getTime()) throw httpError('waitlist_time_window_mismatch',409);
      if(row.estimated_duration_minutes){
        const durationMinutes=(new Date(a.ends_at).getTime()-new Date(a.starts_at).getTime())/60000;
        if(!Number.isFinite(durationMinutes)||durationMinutes<Number(row.estimated_duration_minutes)) throw httpError('waitlist_duration_mismatch',409);
      }
      nextState='booked';
    }else if(input.action==='cancel'){
      if(!['waiting','offered'].includes(row.state)) throw httpError('waitlist_transition_invalid',409);
      nextState='cancelled';
    }else if(input.action==='expire'){
      if(row.state!=='offered') throw httpError('waitlist_transition_invalid',409);
      nextState='expired';
    }else{
      if(!['offered','expired'].includes(row.state)) throw httpError('waitlist_transition_invalid',409);
      nextState='waiting';
    }

    const updated=await client.query(`update shop_waitlist_entries set
      state=$2,
      offer_expires_at=case when $2='offered' then $3::timestamptz else null end,
      booked_appointment_id=case when $2='booked' then $4::uuid else booked_appointment_id end,
      updated_at=now()
      where id=$1 returning *`,[entryId,nextState,canonicalOfferExpiry,input.appointmentId??null]);
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}