import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

type Queryable=Pick<PoolClient,'query'>;

export async function loadCoreCaseForPrincipal(principal:Principal,caseId:string,db:Queryable=pool){
  const r=await db.query(`select c.*, owner.organization_id as owner_organization_id
    from core_cases c left join actors owner on owner.id=c.current_owner_actor_id where c.id=$1`,[caseId]);
  if(!r.rowCount)return null;
  const c=r.rows[0];
  if(principal.role==='admin'){
    // Token-backed platform admins have no actor scope. Actor-backed admins are tenant/location staff
    // and must not gain cross-organization access merely by holding the admin role.
    if(!principal.actorId)return c;
    const actor=await db.query('select organization_id,location_id,status from actors where id=$1',[principal.actorId]);
    if(!actor.rowCount||actor.rows[0].status!=='active'||!actor.rows[0].organization_id)throw new Error('forbidden');
    if(!c.owner_organization_id||c.owner_organization_id!==actor.rows[0].organization_id)throw new Error('forbidden');
    return c;
  }
  if(!principal.actorId)throw new Error('forbidden');
  if(principal.role==='customer'){
    if(c.customer_actor_id!==principal.actorId)throw new Error('forbidden');
    return c;
  }
  // Until domain-specific assignment relations are projected into the universal kernel,
  // non-customer actors may mutate/read only cases explicitly owned by them.
  if(c.current_owner_actor_id!==principal.actorId)throw new Error('forbidden');
  return c;
}
