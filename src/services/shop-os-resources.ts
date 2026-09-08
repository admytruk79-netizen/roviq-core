import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

type Queryable=Pick<PoolClient,'query'>;
export type ShopResourceType='bay'|'technician'|'advisor'|'equipment'|'mobile_unit'|'tow_unit'|'valet_driver'|'loaner_vehicle';
export type ShopResourceState='available'|'busy'|'blocked'|'offline';

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

async function resolveShopScope(principal:Principal,input:{organizationId?:string;locationId?:string},db:Queryable){
  return resolveShopPrincipalScope(principal,input,db);
}

async function loadNativeConnection(organizationId:string,locationId:string|null,db:Queryable){
  const result=await db.query(`
    select id from partner_system_connections
    where organization_id=$1
      and mode='roviq_native'
      and connection_status='active'
      and (location_id=$2::uuid or ($2::uuid is null and location_id is null))
    order by created_at asc limit 1`,[organizationId,locationId]);
  if(!result.rowCount) throw httpError('shop_os_native_connection_required',409);
  return result.rows[0].id as string;
}

async function assertAssignedActorScope(actorId:string|null|undefined,organizationId:string,locationId:string|null,db:Queryable){
  if(!actorId)return;
  const actor=await db.query(`select id,organization_id,location_id,status from actors where id=$1`,[actorId]);
  if(!actor.rowCount||actor.rows[0].status!=='active') throw httpError('resource_actor_not_found',404);
  if(actor.rows[0].organization_id!==organizationId) throw httpError('resource_actor_tenant_mismatch',409);
  if(locationId&&actor.rows[0].location_id&&actor.rows[0].location_id!==locationId) throw httpError('resource_actor_location_mismatch',409);
}

export async function createShopResource(principal:Principal,input:{
  organizationId?:string;locationId?:string;resourceType:ShopResourceType;displayName:string;
  capabilityTags?:string[];constraints?:Record<string,unknown>;assignedActorId?:string|null;
  operationalState?:ShopResourceState;hourlyCost?:number|null;laborRate?:number|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const scope=await resolveShopScope(principal,input,client);
    await assertAssignedActorScope(input.assignedActorId,scope.organizationId,scope.locationId,client);
    const connectionId=await loadNativeConnection(scope.organizationId,scope.locationId,client);
    const created=await client.query(`insert into service_resources(
      organization_id,location_id,resource_type,display_name,active,capability_tags,constraints,source_connection_id,
      operational_state,assigned_actor_id,hourly_cost,labor_rate
    ) values($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11) returning *`,[
      scope.organizationId,scope.locationId,input.resourceType,input.displayName,input.capabilityTags??[],
      JSON.stringify(input.constraints??{}),connectionId,input.operationalState??'available',input.assignedActorId??null,
      input.hourlyCost??null,input.laborRate??null
    ]);
    await client.query('commit');
    return created.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function listShopResources(principal:Principal,input:{
  organizationId?:string;locationId?:string;resourceType?:ShopResourceType;includeInactive?:boolean;
}){
  const client=await pool.connect();
  try{
    const scope=await resolveShopScope(principal,input,client);
    const result=await client.query(`
      select r.*
      from service_resources r
      join partner_system_connections c
        on c.id=r.source_connection_id
       and c.mode='roviq_native'
      where r.organization_id=$1
        and c.organization_id=$1
        and ($2::uuid is null or r.location_id=$2::uuid)
        and ($2::uuid is null or c.location_id=$2::uuid)
        and ($3::text is null or r.resource_type=$3)
        and ($4::boolean=true or r.active=true)
      order by r.resource_type,r.display_name,r.id`,[
      scope.organizationId,scope.locationId,input.resourceType??null,input.includeInactive??false
    ]);
    return {scope,resources:result.rows};
  }finally{client.release();}
}

export async function updateShopResource(principal:Principal,resourceId:string,input:{
  displayName?:string;capabilityTags?:string[];constraints?:Record<string,unknown>;assignedActorId?:string|null;
  operationalState?:ShopResourceState;active?:boolean;hourlyCost?:number|null;laborRate?:number|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(`
      select r.*
      from service_resources r
      join partner_system_connections c on c.id=r.source_connection_id and c.mode='roviq_native'
      where r.id=$1
      for update of r`,[resourceId]);
    if(!current.rowCount) throw httpError('shop_os_resource_not_found',404);
    const row=current.rows[0];
    await resolveShopScope(principal,{organizationId:row.organization_id,locationId:row.location_id},client);
    await assertAssignedActorScope(input.assignedActorId,row.organization_id,row.location_id,client);
    if(input.active===false){
      const activeAppointments=await client.query(`select 1 from roviq_appointments
        where resource_id=$1 and appointment_status in ('held','confirmed','in_progress') limit 1`,[resourceId]);
      if(activeAppointments.rowCount) throw httpError('resource_has_active_appointments',409);
    }
    const updated=await client.query(`update service_resources set
      display_name=coalesce($2,display_name),
      capability_tags=coalesce($3::text[],capability_tags),
      constraints=coalesce($4::jsonb,constraints),
      assigned_actor_id=case when $5::boolean then $6::uuid else assigned_actor_id end,
      operational_state=coalesce($7,operational_state),
      active=coalesce($8,active),
      hourly_cost=case when $9::boolean then $10::numeric else hourly_cost end,
      labor_rate=case when $11::boolean then $12::numeric else labor_rate end,
      updated_at=now()
      where id=$1 returning *`,[
      resourceId,input.displayName??null,input.capabilityTags??null,input.constraints?JSON.stringify(input.constraints):null,
      Object.prototype.hasOwnProperty.call(input,'assignedActorId'),input.assignedActorId??null,
      input.operationalState??null,input.active??null,
      Object.prototype.hasOwnProperty.call(input,'hourlyCost'),input.hourlyCost??null,
      Object.prototype.hasOwnProperty.call(input,'laborRate'),input.laborRate??null
    ]);
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
