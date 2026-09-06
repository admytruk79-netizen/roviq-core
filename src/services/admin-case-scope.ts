import type { PoolClient } from 'pg';
import type { Principal } from '../types/principal.js';

type Queryable=Pick<PoolClient,'query'>;

function scopedError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

export async function getAdminActorScope(principal:Principal,db:Queryable){
  if(principal.role!=='admin') throw scopedError('forbidden',403);
  if(!principal.actorId) return null;
  const actor=await db.query(`select organization_id,location_id,status from actors where id=$1`,[principal.actorId]);
  if(!actor.rowCount||actor.rows[0].status!=='active'||!actor.rows[0].organization_id) throw scopedError('forbidden',403);
  return {
    organizationId:actor.rows[0].organization_id as string,
    locationId:actor.rows[0].location_id as string|null
  };
}

export async function assertAdminCaseScope(principal:Principal,caseId:string,db:Queryable){
  const scope=await getAdminActorScope(principal,db);
  const exists=await db.query(`select id from service_cases where id=$1`,[caseId]);
  if(!exists.rowCount) throw scopedError('case_not_found',404);
  if(!scope) return;

  const linked=await db.query(`
    select exists(
      select 1
      from service_cases sc
      left join actors owner on owner.id=sc.current_owner_actor_id
      left join actors selected on selected.id=sc.selected_actor_id
      left join actors recommended on recommended.id=sc.recommended_actor_id
      where sc.id=$1 and (
        (owner.organization_id=$2 and ($3::uuid is null or owner.location_id=$3))
        or (selected.organization_id=$2 and ($3::uuid is null or selected.location_id=$3))
        or (recommended.organization_id=$2 and ($3::uuid is null or recommended.location_id=$3))
        or exists(
          select 1 from matches_offers mo
          join actors provider on provider.id=mo.actor_id
          where mo.case_id=sc.id
            and provider.organization_id=$2
            and ($3::uuid is null or provider.location_id=$3)
        )
      )
    ) as linked`,[caseId,scope.organizationId,scope.locationId]);
  if(!linked.rows[0]?.linked) throw scopedError('forbidden',403);
}

export async function assertExceptionOwnerScope(ownerActorId:string,caseId:string,db:Queryable){
  const owner=await db.query(`select id,organization_id,location_id,status from actors where id=$1`,[ownerActorId]);
  if(!owner.rowCount||owner.rows[0].status!=='active'||!owner.rows[0].organization_id){
    throw scopedError('exception_owner_invalid',409);
  }
  const row=owner.rows[0];
  const linked=await db.query(`
    select exists(
      select 1
      from service_cases sc
      left join actors current_owner on current_owner.id=sc.current_owner_actor_id
      left join actors selected on selected.id=sc.selected_actor_id
      left join actors recommended on recommended.id=sc.recommended_actor_id
      where sc.id=$1 and (
        (current_owner.organization_id=$2 and ($3::uuid is null or current_owner.location_id=$3))
        or (selected.organization_id=$2 and ($3::uuid is null or selected.location_id=$3))
        or (recommended.organization_id=$2 and ($3::uuid is null or recommended.location_id=$3))
        or exists(
          select 1 from matches_offers mo
          join actors provider on provider.id=mo.actor_id
          where mo.case_id=sc.id
            and provider.organization_id=$2
            and ($3::uuid is null or provider.location_id=$3)
        )
      )
    ) as linked`,[caseId,row.organization_id,row.location_id]);
  if(!linked.rows[0]?.linked) throw scopedError('exception_owner_scope_mismatch',409);
}
