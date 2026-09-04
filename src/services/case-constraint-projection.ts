import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient,'query'>;
type ConstraintStatus = 'required'|'satisfied'|'waived'|'blocked'|'unknown';

/**
 * Projects authoritative operating-layer state into case_constraints.
 * The source tables remain authoritative; case_constraints is the single
 * serviceability-facing projection consumed by routing/hold/confirmation.
 */
export async function syncOperationalConstraints(caseId:string,db:Queryable):Promise<void>{
  await syncPartsConstraint(caseId,db);
  await syncMobilityConstraint(caseId,db);
}

export function derivePartsConstraint(counts:Record<string,number>):{status:ConstraintStatus;total:number;ready:number}{
  const total=Object.values(counts).reduce((sum,value)=>sum+Number(value),0);
  const ready=counts.ready??0;
  const status:ConstraintStatus=(counts.unavailable??0)>0?'blocked':ready===total?'satisfied':'required';
  return {status,total,ready};
}

export function deriveMobilityConstraint(states:string[]):{status:ConstraintStatus;currentState:string|null;history:Record<string,number>}{
  const history:Record<string,number>={};
  for(const state of states) history[state]=(history[state]??0)+1;
  const currentState=states[0]??null;
  if(!currentState) return {status:'required',currentState,history};
  if(['reserved','assigned','active','return_pending','completed'].includes(currentState)) return {status:'satisfied',currentState,history};
  if(['failed','declined'].includes(currentState)) return {status:'blocked',currentState,history};
  return {status:'required',currentState,history};
}

async function syncPartsConstraint(caseId:string,db:Queryable){
  const result=await db.query(
    `select readiness_status,count(*)::int as count
       from case_parts_requirements
      where service_case_id=$1 and readiness_status<>'cancelled'
      group by readiness_status`,
    [caseId]
  );
  if(!result.rowCount){
    await deleteProjection(caseId,'parts-readiness',db);
    return;
  }
  const counts=Object.fromEntries(result.rows.map((row:any)=>[String(row.readiness_status),Number(row.count)]));
  const {status,total,ready}=derivePartsConstraint(counts);
  await upsertProjection(caseId,'parts','parts-readiness',status,{counts,total,ready},db);
}

async function syncMobilityConstraint(caseId:string,db:Queryable){
  const result=await db.query(
    `select state,created_at
       from mobility_allocations
      where case_id=$1 and state<>'cancelled'
      order by created_at desc,id desc`,
    [caseId]
  );
  if(!result.rowCount){
    await deleteProjection(caseId,'mobility-allocation',db);
    return;
  }
  const states=result.rows.map((row:any)=>String(row.state));
  const {status,currentState,history}=deriveMobilityConstraint(states);
  await upsertProjection(caseId,'mobility','mobility-allocation',status,{currentState,history},db);
}

async function upsertProjection(
  caseId:string,
  type:'parts'|'mobility',
  projectionKey:string,
  status:ConstraintStatus,
  details:Record<string,unknown>,
  db:Queryable
){
  await db.query(
    `insert into case_constraints(service_case_id,constraint_type,status,details,source_type,projection_key,source_updated_at,updated_at)
     values($1,$2,$3,$4,'operational_projection',$5,now(),now())
     on conflict(service_case_id,projection_key) where projection_key is not null
     do update set constraint_type=excluded.constraint_type,status=excluded.status,details=excluded.details,
                   source_type=excluded.source_type,source_updated_at=excluded.source_updated_at,updated_at=now()`,
    [caseId,type,status,JSON.stringify(details),projectionKey]
  );
}

async function deleteProjection(caseId:string,projectionKey:string,db:Queryable){
  await db.query(
    `delete from case_constraints where service_case_id=$1 and projection_key=$2 and source_type='operational_projection'`,
    [caseId,projectionKey]
  );
}
