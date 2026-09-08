import type { PoolClient } from 'pg';
import type { Principal } from '../types/principal.js';

type Queryable=Pick<PoolClient,'query'>;

function scopedError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

export async function resolveShopPrincipalScope(
  principal:Principal,
  input:{organizationId?:string;locationId?:string},
  db:Queryable
){
  if(principal.role!=='admin'&&principal.role!=='partner') throw scopedError('forbidden',403);

  // Global service/admin principals intentionally have no actor id. Actor-backed admins are tenant scoped.
  if(principal.role==='admin'&&!principal.actorId){
    if(!input.organizationId) throw scopedError('organization_id_required',400);
    return {organizationId:input.organizationId,locationId:input.locationId??null};
  }

  if(!principal.actorId) throw scopedError('forbidden',403);
  const actor=await db.query(`select organization_id,location_id,status from actors where id=$1`,[principal.actorId]);
  if(!actor.rowCount||actor.rows[0].status!=='active'||!actor.rows[0].organization_id) throw scopedError('forbidden',403);
  const organizationId=actor.rows[0].organization_id as string;
  const locationId=actor.rows[0].location_id as string|null;
  if(input.organizationId&&input.organizationId!==organizationId) throw scopedError('forbidden',403);
  if(locationId&&input.locationId&&input.locationId!==locationId) throw scopedError('forbidden',403);
  return {organizationId,locationId:locationId??input.locationId??null};
}

export async function assertShopPrincipalScope(
  principal:Principal,
  organizationId:string,
  locationId:string|null|undefined,
  db:Queryable
){
  return resolveShopPrincipalScope(principal,{organizationId,locationId:locationId??undefined},db);
}
