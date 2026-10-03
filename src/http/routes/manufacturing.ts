import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {pool} from "../../db/pool.js";
import {requireRole} from "../middleware/principal.js";
import {persistManufacturingTransition} from "../../domain/manufacturing/store.js";

const transition=z.object({to:z.enum(["manufacturer-accepted","in-production","qc-passed","shipped","delivered"]),metadata:z.record(z.string()).default({})});
export async function manufacturingRoutes(app:FastifyInstance){
 app.get("/api/manufacturing/jobs",{preHandler:requireRole("partner","admin")},async(req)=>{
  const actor=req.principal.actorId;
  const r=req.principal.role==="admin"
   ?await pool.query("select * from manufacturing_jobs order by updated_at desc limit 100")
   :await pool.query("select * from manufacturing_jobs where manufacturer_actor_id=$1 order by updated_at desc limit 100",[actor]);
  return {jobs:r.rows};
 });
 app.get("/api/manufacturing/jobs/:externalJobId",{preHandler:requireRole("partner","admin")},async(req,reply)=>{
  const {externalJobId}=req.params as {externalJobId:string}; const actor=req.principal.actorId;
  const r=req.principal.role==="admin"
   ?await pool.query("select * from manufacturing_jobs where external_job_id=$1",[externalJobId])
   :await pool.query("select * from manufacturing_jobs where external_job_id=$1 and manufacturer_actor_id=$2",[externalJobId,actor]);
  if(!r.rowCount)return reply.code(404).send({error:"manufacturing_job_not_found"});
  const e=await pool.query("select event_type,actor_id,payload,previous_version,new_version,occurred_at from manufacturing_events where manufacturing_job_id=$1 order by new_version",[r.rows[0].id]);
  return {job:r.rows[0],events:e.rows};
 });
 app.post("/api/manufacturing/jobs/:externalJobId/transition",{preHandler:requireRole("partner","admin")},async(req,reply)=>{
  const {externalJobId}=req.params as {externalJobId:string}; const body=transition.parse(req.body);
  const key=typeof req.headers["idempotency-key"]==="string"?req.headers["idempotency-key"]:undefined;
  if(!key)return reply.code(400).send({error:"idempotency_key_required"});
  const actor=req.principal.actorId;
  const q=req.principal.role==="admin"
   ?await pool.query("select status from manufacturing_jobs where external_job_id=$1",[externalJobId])
   :await pool.query("select status from manufacturing_jobs where external_job_id=$1 and manufacturer_actor_id=$2",[externalJobId,actor]);
  if(!q.rowCount)return reply.code(404).send({error:"manufacturing_job_not_found"});
  const client=await pool.connect();
  try{
   const result=await persistManufacturingTransition(client,{eventId:crypto.randomUUID(),jobId:externalJobId,occurredAt:new Date().toISOString(),from:q.rows[0].status,to:body.to,actorId:actor??"system-admin",idempotencyKey:key,metadata:body.metadata});
   return reply.code(result.duplicate?200:201).send(result);
  }finally{client.release();}
 });
}
