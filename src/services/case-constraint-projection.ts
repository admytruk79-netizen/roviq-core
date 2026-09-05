import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient,'query'>;
type ConstraintStatus = 'required'|'satisfied'|'waived'|'blocked'|'unknown';
type ProjectionType = 'parts'|'mobility'|'customer_time'|'approval'|'transport';

/**
 * Projects authoritative operating-layer state into case_constraints.
 * The source tables remain authoritative; case_constraints is the single
 * serviceability-facing projection consumed by routing/hold/confirmation.
 */
export async function syncOperationalConstraints(caseId:string,db:Queryable):Promise<void>{
  await syncPartsConstraint(caseId,db);
  await syncMobilityConstraint(caseId,db);
  await syncCustomerTimeConstraint(caseId,db);
  await syncApprovalConstraint(caseId,db);
  await syncTransportConstraint(caseId,db);
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

export function deriveCustomerTimeConstraint(
  appointmentStatus:string,
  startsAt:string|Date,
  endsAt:string|Date,
  now=new Date()
):{status:ConstraintStatus;appointmentStatus:string;expired:boolean}{
  const startMs=new Date(startsAt).getTime();
  const endMs=new Date(endsAt).getTime();
  const expired=Number.isFinite(endMs)&&endMs<=now.getTime();
  if(['cancelled','released'].includes(appointmentStatus)) return {status:'required',appointmentStatus,expired};
  if(['held','confirmed'].includes(appointmentStatus) && expired) return {status:'required',appointmentStatus,expired:true};
  if(['held','confirmed','in_progress','completed'].includes(appointmentStatus)) return {status:'satisfied',appointmentStatus,expired};
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)) return {status:'unknown',appointmentStatus,expired};
  return {status:'required',appointmentStatus,expired};
}

export function deriveApprovalConstraint(states:string[]):{status:ConstraintStatus;states:string[]}{
  if(!states.length) return {status:'required',states};
  if(states.some((state)=>['rejected','expired','revoked'].includes(state))) return {status:'blocked',states};
  if(states.every((state)=>state==='approved')) return {status:'satisfied',states};
  if(states.some((state)=>state==='pending')) return {status:'required',states};
  return {status:'unknown',states};
}

export function deriveTransportConstraint(
  transportStatus:string,
  dropoffLocation:unknown
):{status:ConstraintStatus;transportStatus:string;destinationReady:boolean}{
  const destinationReady=!!dropoffLocation && typeof dropoffLocation==='object' && Object.keys(dropoffLocation as Record<string,unknown>).length>0;
  if(['declined','failed'].includes(transportStatus)) return {status:'blocked',transportStatus,destinationReady};
  if(!destinationReady) return {status:'required',transportStatus,destinationReady:false};
  if(['accepted','en_route','arrived','vehicle_loaded','in_transit','delivered'].includes(transportStatus)) {
    return {status:'satisfied',transportStatus,destinationReady:true};
  }
  if(['requested','assigned'].includes(transportStatus)) return {status:'required',transportStatus,destinationReady:true};
  return {status:'unknown',transportStatus,destinationReady};
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

async function syncCustomerTimeConstraint(caseId:string,db:Queryable){
  const result=await db.query(
    `select id,appointment_status,starts_at,ends_at
       from roviq_appointments
      where service_case_id=$1 and appointment_status not in ('cancelled','released')
      order by updated_at desc,id desc
      limit 1`,
    [caseId]
  );
  if(!result.rowCount){
    await deleteProjection(caseId,'customer-time',db);
    return;
  }
  const row=result.rows[0];
  const derived=deriveCustomerTimeConstraint(String(row.appointment_status),row.starts_at,row.ends_at);
  await upsertProjection(caseId,'customer_time','customer-time',derived.status,{
    appointmentId:row.id,
    appointmentStatus:derived.appointmentStatus,
    startsAt:row.starts_at,
    endsAt:row.ends_at,
    expired:derived.expired
  },db);
}

async function syncApprovalConstraint(caseId:string,db:Queryable){
  const result=await db.query(
    `select ca.id,ca.state,ca.revision,sp.current_revision
       from case_approvals ca
       left join service_plans sp on sp.id=ca.service_plan_id
      where ca.case_id=$1
        and (ca.service_plan_id is null or ca.revision is null or ca.revision=sp.current_revision)
      order by ca.created_at desc,ca.id desc`,
    [caseId]
  );
  if(!result.rowCount){
    await deleteProjection(caseId,'approval-state',db);
    return;
  }
  const states=result.rows.map((row:any)=>String(row.state));
  const derived=deriveApprovalConstraint(states);
  await upsertProjection(caseId,'approval','approval-state',derived.status,{
    states:derived.states,
    approvalIds:result.rows.map((row:any)=>row.id),
    currentRevision:result.rows.find((row:any)=>row.current_revision!=null)?.current_revision ?? null
  },db);
}

async function syncTransportConstraint(caseId:string,db:Queryable){
  const result=await db.query(
    `select id,transport_type,status,dropoff_location,provider_actor_id,eta_at,updated_at
       from transport_dispatches
      where case_id=$1 and status<>'cancelled'
      order by updated_at desc,id desc
      limit 1`,
    [caseId]
  );
  if(!result.rowCount){
    await deleteProjection(caseId,'transport-readiness',db);
    return;
  }
  const row=result.rows[0];
  const derived=deriveTransportConstraint(String(row.status),row.dropoff_location);
  await upsertProjection(caseId,'transport','transport-readiness',derived.status,{
    dispatchId:row.id,
    transportType:row.transport_type,
    transportStatus:derived.transportStatus,
    destinationReady:derived.destinationReady,
    providerActorId:row.provider_actor_id ?? null,
    etaAt:row.eta_at ?? null
  },db);
}

async function upsertProjection(
  caseId:string,
  type:ProjectionType,
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
