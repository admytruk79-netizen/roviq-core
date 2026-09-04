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
  const total=Object.values(counts).reduce((sum:number,value:any)=>sum+Number(value),0);
  const ready=(counts.ready??0)+(counts.received??0);
  const status:ConstraintStatus=(counts.unavailable??0)>0?'blocked':ready===total?'satisfied':'required';
  await upsertProjection(caseId,'parts','parts-readiness',status,{counts,total,ready},db);
}

async function syncMobilityConstraint(caseId:string,db:Queryable){
  const result=await db.query(
    `select state,count(*)::int as count
       from mobility_allocations
      where case_id=$1 and state<>'cancelled'
      group by state`,
    [caseId]
  );
  if(!result.rowCount){
    await deleteProjection(caseId,'mobility-allocation',db);
    return;
  }
  const counts=Object.fromEntries(result.rows.map((row:any)=>[String(row.state),Number(row.count)]));
  const blocked=(counts.failed??0)+(counts.declined??0);
  const satisfied=(counts.reserved??0)+(counts.assigned??0)+(counts.active??0)+(counts.return_pending??0)+(counts.completed??0);
  const status:ConstraintStatus=blocked>0?'blocked':satisfied>0?'satisfied':'required';
  await upsertProjection(caseId,'mobility','mobility-allocation',status,{counts},db);
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
