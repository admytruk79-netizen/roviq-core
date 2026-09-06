import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';

type Queryable=Pick<PoolClient,'query'>;
export type ShopWaitlistAction='offer'|'book'|'cancel'|'expire'|'requeue';

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

async function resolveScope(principal:Principal,input:{organizationId?:string;locationId?:string},db:Queryable){
  if(principal.role==='admin'){
    if(!input.organizationId) throw httpError('organization_id_required',400);
    return {organizationId:input.organizationId,locationId:input.locationId??null};
  }
  if(principal.role!=='partner'||!principal.actorId) throw httpError('forbidden',403);
  const actor=await db.query(`select organization_id,location_id from actors where id=$1 and status='active'`,[principal.actorId]);
  if(!actor.rowCount||!actor.rows[0].organization_id) throw httpError('forbidden',403);
  const organizationId=actor.rows[0].organization_id as string;
  const actorLocationId=actor.rows[0].location_id as string|null;
  if(input.organizationId&&input.organizationId!==organizationId) throw httpError('forbidden',403);
  if(actorLocationId&&input.locationId&&input.locationId!==actorLocationId) throw httpError('forbidden',403);
  return {organizationId,locationId:actorLocationId??input.locationId??null};
}

async function assertCase(principal:Principal,serviceCaseId:string|null|undefined,db:Queryable){
  if(!serviceCaseId)return;
  try{ await assertCaseAccess(principal,serviceCaseId,db); }
  catch(error){
    if(error instanceof Error&&error.message==='case_not_found') throw httpError('service_case_not_found',404);
    if(error instanceof Error&&error.message==='forbidden') throw httpError('forbidden',403);
    throw error;
  }
}

export async function createShopWaitlistEntry(principal:Principal,input:{
  organizationId?:string;
  locationId?:string;
  serviceCaseId?:string|null;
  requestedServiceCategory?:string|null;
  requestedAfter?:string|null;
  requestedBefore?:string|null;
  estimatedDurationMinutes?:number|null;
  preferredResourceTypes?:string[];
  priority?:number;
  notes?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const scope=await resolveScope(principal,input,client);
    await assertCase(principal,input.serviceCaseId,client);
    const created=await client.query(`insert into shop_waitlist_entries(
      organization_id,location_id,service_case_id,requested_service_category,requested_after,requested_before,
      estimated_duration_minutes,preferred_resource_types,priority,notes,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,[
      scope.organizationId,scope.locationId,input.serviceCaseId??null,input.requestedServiceCategory??null,
      input.requestedAfter??null,input.requestedBefore??null,input.estimatedDurationMinutes??null,
      input.preferredResourceTypes??[],input.priority??100,input.notes??null,principal.actorId??null
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

export async function updateShopWaitlistEntry(principal:Principal,entryId:string,input:{
  action:ShopWaitlistAction;
  appointmentId?:string;
  offerExpiresAt?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(`select * from shop_waitlist_entries where id=$1 for update`,[entryId]);
    if(!current.rowCount) throw httpError('waitlist_entry_not_found',404);
    const row=current.rows[0];
    await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},client);
    await assertCase(principal,row.service_case_id,client);

    let nextState:string;
    if(input.action==='offer'){
      if(row.state!=='waiting') throw httpError('waitlist_transition_invalid',409);
      if(!input.offerExpiresAt) throw httpError('offer_expires_at_required',400);
      nextState='offered';
    }else if(input.action==='book'){
      if(!['waiting','offered'].includes(row.state)) throw httpError('waitlist_transition_invalid',409);
      if(!input.appointmentId) throw httpError('appointment_id_required',400);
      const appointment=await client.query(`select id,organization_id,location_id from roviq_appointments where id=$1`,[input.appointmentId]);
      if(!appointment.rowCount) throw httpError('appointment_not_found',404);
      if(appointment.rows[0].organization_id!==row.organization_id) throw httpError('forbidden',403);
      if(row.location_id&&appointment.rows[0].location_id!==row.location_id) throw httpError('forbidden',403);
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
      where id=$1 returning *`,[entryId,nextState,input.offerExpiresAt??null,input.appointmentId??null]);
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
