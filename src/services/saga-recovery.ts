import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

type Queryable=Pick<PoolClient,'query'>;
export type SagaState='running'|'waiting'|'retry_scheduled'|'compensating'|'needs_review'|'completed'|'cancelled'|'failed';

export async function startSaga(caseId:string,sagaType:string,context:Record<string,unknown>={},db:Queryable=pool){
  const r=await db.query(`insert into core_sagas(case_id,saga_type,context,next_action_at) values($1,$2,$3,now()) returning *`,[caseId,sagaType,context]);
  return r.rows[0];
}
export async function addSagaStep(sagaId:string,stepKey:string,input:Record<string,unknown>={},db:Queryable=pool){
  const key=`${sagaId}:${stepKey}:1:${randomUUID()}`;
  const r=await db.query(`insert into core_saga_steps(saga_id,step_key,state,idempotency_key,input,next_attempt_at)
    values($1,$2,'pending',$3,$4,now()) returning *`,[sagaId,stepKey,key,input]);return r.rows[0];
}
export async function claimReadySaga(db:Queryable=pool){
  const r=await db.query(`with candidate as (
    select id from core_sagas where state in ('running','retry_scheduled') and coalesce(next_action_at,now())<=now()
    order by coalesce(next_action_at,created_at),created_at for update skip locked limit 1
  ) update core_sagas s set next_action_at=now()+interval '5 minutes',updated_at=now()
    from candidate c where s.id=c.id returning s.*`);
  return r.rows[0]??null;
}
export async function recordStepSuccess(stepId:string,output:Record<string,unknown>,db:Queryable=pool){
  await db.query(`update core_saga_steps set state='succeeded',output=$2,error=null,finished_at=now(),next_attempt_at=null where id=$1`,[stepId,output]);
}
export async function recordStepFailure(stepId:string,error:unknown,maxAttempts=5,db:Queryable=pool){
  const message=error instanceof Error?error.message:String(error);
  const r=await db.query('select * from core_saga_steps where id=$1 for update',[stepId]); if(!r.rowCount)return null;
  const step=r.rows[0], retry=Number(step.attempt)<maxAttempts;
  await db.query(`update core_saga_steps set state=$2,error=left($3,2000),finished_at=now(),
    next_attempt_at=case when $2='failed' then now()+(least(attempt,8)*interval '30 seconds') else null end where id=$1`,
    [stepId,retry?'failed':'needs_review',message]);
  await db.query(`update core_sagas set state=$2,last_error=left($3,2000),updated_at=now(),
    next_action_at=case when $2='retry_scheduled' then now()+(least($4,8)*interval '30 seconds') else null end where id=$1`,
    [step.saga_id,retry?'retry_scheduled':'needs_review',message,Number(step.attempt)]);
  return {retry};
}
export async function scheduleNextAttempt(stepId:string,db:Queryable=pool){
  const r=await db.query('select * from core_saga_steps where id=$1 for update',[stepId]);if(!r.rowCount)return null;
  const prior=r.rows[0], attempt=Number(prior.attempt)+1;
  const n=await db.query(`insert into core_saga_steps(saga_id,step_key,attempt,state,idempotency_key,input,next_attempt_at)
    values($1,$2,$3,'pending',$4,$5,now()) returning *`,
    [prior.saga_id,prior.step_key,attempt,`${prior.saga_id}:${prior.step_key}:${attempt}:${randomUUID()}`,prior.input]);
  return n.rows[0];
}
export async function completeSaga(sagaId:string,db:Queryable=pool){
  const r=await db.query(`update core_sagas set state='completed',completed_at=now(),next_action_at=null,last_error=null,updated_at=now(),version=version+1
    where id=$1 and state not in ('completed','cancelled') returning *`,[sagaId]);return r.rows[0]??null;
}
export async function markSagaNeedsReview(sagaId:string,reason:string,db:Queryable=pool){
  const r=await db.query(`update core_sagas set state='needs_review',last_error=left($2,2000),next_action_at=null,updated_at=now(),version=version+1
    where id=$1 returning *`,[sagaId,reason]);return r.rows[0]??null;
}
