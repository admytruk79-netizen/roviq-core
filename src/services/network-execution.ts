import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

type Queryable = Pick<PoolClient,'query'>;

export type ParticipantDecision='accepted'|'declined';
export type NetworkHandoffType='service_provider'|'parts'|'transport'|'mobility'|'diagnostic'|'other';
export type NetworkHandoffStatus='planned'|'assigned'|'accepted'|'in_progress'|'completed'|'declined'|'failed'|'cancelled';

export function handoffStatusForTransport(status:string):NetworkHandoffStatus{
  if(status==='assigned') return 'assigned';
  if(status==='accepted') return 'accepted';
  if(['en_route','arrived','vehicle_loaded','in_transit'].includes(status)) return 'in_progress';
  if(status==='delivered') return 'completed';
  if(status==='declined') return 'declined';
  if(status==='failed') return 'failed';
  if(status==='cancelled') return 'cancelled';
  return 'planned';
}

export function handoffStatusForMobility(status:string):NetworkHandoffStatus{
  if(['requested','reserved'].includes(status)) return 'planned';
  if(status==='assigned') return 'assigned';
  if(['active','return_pending'].includes(status)) return 'in_progress';
  if(status==='completed') return 'completed';
  if(status==='declined') return 'declined';
  if(status==='failed') return 'failed';
  if(status==='cancelled') return 'cancelled';
  return 'planned';
}

export function handoffStatusForParts(status:string):NetworkHandoffStatus{
  if(status==='requested') return 'planned';
  if(['supplier_assigned','reserved','ordered','shipped'].includes(status)) return status==='supplier_assigned'?'assigned':'in_progress';
  if(status==='delivered') return 'completed';
  if(status==='failed') return 'failed';
  if(status==='cancelled') return 'cancelled';
  return 'planned';
}

async function latestPlanForCase(caseId:string,db:Queryable){
  const result=await db.query(
    `select * from fulfillment_plans
      where service_case_id=$1 and status<>'superseded'
      order by version desc limit 1`,
    [caseId]
  );
  return result.rows[0]??null;
}

export async function syncFulfillmentParticipantDecision(input:{
  caseId:string;
  actorId:string;
  decision:ParticipantDecision;
  sourceType:string;
  sourceReferenceId?:string|null;
  metadata?:Record<string,unknown>;
},queryable?:Queryable){
  const db=queryable??pool;
  const plan=await latestPlanForCase(input.caseId,db);
  if(!plan) return null;

  const candidateResult=await db.query(
    `select * from fulfillment_candidates
      where fulfillment_plan_id=$1 and actor_id=$2
      limit 1`,
    [plan.id,input.actorId]
  );
  const candidate=candidateResult.rows[0]??null;
  if(!candidate) return null;

  const acceptance=await db.query(
    `insert into participant_acceptances(
       fulfillment_plan_id,fulfillment_candidate_id,service_case_id,actor_id,decision,
       source_type,source_reference_id,metadata
     ) values($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict(fulfillment_plan_id,actor_id)
     do update set decision=excluded.decision,source_type=excluded.source_type,
       source_reference_id=excluded.source_reference_id,metadata=excluded.metadata,
       decided_at=now(),updated_at=now()
     returning *`,
    [
      plan.id,candidate.id,input.caseId,input.actorId,input.decision,input.sourceType,
      input.sourceReferenceId??null,JSON.stringify(input.metadata??{})
    ]
  );

  await db.query(
    `update fulfillment_candidates
       set participant_status=$1,updated_at=now()
     where id=$2`,
    [input.decision,candidate.id]
  );

  if(input.decision==='accepted'){
    await db.query(
      `update fulfillment_candidates
         set participant_status='expired',updated_at=now()
       where fulfillment_plan_id=$1 and id<>$2 and participant_status='proposed'`,
      [plan.id,candidate.id]
    );
    await db.query(
      `update fulfillment_plans
         set status='accepted',selected_actor_id=$2,updated_at=now()
       where id=$1 and status in ('feasible','accepted')`,
      [plan.id,input.actorId]
    );
  }else{
    await db.query(
      `update fulfillment_plans
         set status='blocked',
             selected_actor_id=case when selected_actor_id=$2 then null else selected_actor_id end,
             updated_at=now()
       where id=$1 and status in ('feasible','accepted')`,
      [plan.id,input.actorId]
    );
  }

  return {planId:plan.id,candidateId:candidate.id,acceptance:acceptance.rows[0]};
}

export async function upsertNetworkHandoff(input:{
  caseId:string;
  handoffType:NetworkHandoffType;
  participantActorId?:string|null;
  referenceType:string;
  referenceId:string;
  status:NetworkHandoffStatus;
  metadata?:Record<string,unknown>;
},queryable?:Queryable){
  const db=queryable??pool;
  const plan=await latestPlanForCase(input.caseId,db);
  const result=await db.query(
    `insert into network_handoffs(
       service_case_id,fulfillment_plan_id,handoff_type,participant_actor_id,
       reference_type,reference_id,status,metadata
     ) values($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict(service_case_id,handoff_type,reference_type,reference_id)
     do update set fulfillment_plan_id=coalesce(excluded.fulfillment_plan_id,network_handoffs.fulfillment_plan_id),
       participant_actor_id=coalesce(excluded.participant_actor_id,network_handoffs.participant_actor_id),
       status=excluded.status,metadata=network_handoffs.metadata||excluded.metadata,updated_at=now()
     returning *`,
    [
      input.caseId,plan?.id??null,input.handoffType,input.participantActorId??null,
      input.referenceType,input.referenceId,input.status,JSON.stringify(input.metadata??{})
    ]
  );
  return result.rows[0];
}

export async function listNetworkExecutionForPlan(planId:string){
  const [acceptances,handoffs]=await Promise.all([
    pool.query(`select * from participant_acceptances where fulfillment_plan_id=$1 order by decided_at asc`,[planId]),
    pool.query(`select * from network_handoffs where fulfillment_plan_id=$1 order by created_at asc,id asc`,[planId])
  ]);
  return {acceptances:acceptances.rows,handoffs:handoffs.rows};
}
