import type {PoolClient} from "pg";
import type {ManufacturingEvent} from "./ascend-events.js";
import {appendManufacturingTransition} from "./ascend-events.js";

export async function persistManufacturingTransition(client:PoolClient,event:ManufacturingEvent){
 appendManufacturingTransition(event);
 await client.query("begin");
 try{
  const locked=await client.query("select id,status,version from manufacturing_jobs where external_job_id=$1 for update",[event.jobId]);
  const job=locked.rows[0]; if(!job)throw new Error("manufacturing_job_not_found");
  if(job.status!==event.from)throw new Error("manufacturing_state_conflict");
  const nextVersion=Number(job.version)+1;
  const inserted=await client.query(`insert into manufacturing_events(manufacturing_job_id,event_type,actor_id,idempotency_key,payload,previous_version,new_version,occurred_at)
   values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(manufacturing_job_id,idempotency_key) do nothing returning id`,
   [job.id,event.to,event.actorId,event.idempotencyKey,event.metadata,job.version,nextVersion,event.occurredAt]);
  if(inserted.rowCount===0){await client.query("rollback");return {duplicate:true};}
  await client.query("update manufacturing_jobs set status=$1,version=$2,updated_at=$3 where id=$4",[event.to,nextVersion,event.occurredAt,job.id]);
  await client.query("insert into manufacturing_outbox(manufacturing_event_id,topic,payload) values($1,$2,$3)",[inserted.rows[0].id,`manufacturing.${event.to}`,{jobId:event.jobId,...event.metadata}]);
  await client.query("commit"); return {duplicate:false};
 }catch(e){await client.query("rollback");throw e;}
}
