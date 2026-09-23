import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';

const caseType=z.enum(['maintenance','transport','mobility','fleet','trade']);
const createBody=z.object({
  caseType, marketId:z.string().uuid().optional(), locationId:z.string().uuid().optional(),
  priority:z.enum(['low','normal','high','urgent']).default('normal'),
  requirements:z.record(z.unknown()).default({}), constraints:z.record(z.unknown()).default({}),
  attributes:z.record(z.unknown()).default({})
});
const transitionBody=z.object({
  expectedVersion:z.number().int().positive(), requestedTransition:z.string().min(1).max(80),
  evidence:z.record(z.unknown()).default({}), correlationId:z.string().uuid().optional()
});
const allowed:Record<string,ReadonlySet<string>>={
  intake:new Set(['triage','waiting_external','cancelled']),
  triage:new Set(['active','waiting_external','needs_review','cancelled']),
  active:new Set(['waiting_external','needs_review','blocked','completed','cancelled']),
  waiting_external:new Set(['active','needs_review','blocked','expired','cancelled']),
  needs_review:new Set(['active','blocked','cancelled']),
  blocked:new Set(['active','cancelled']),
  retry_scheduled:new Set(['active','degraded','failed']),
  degraded:new Set(['active','retry_scheduled','needs_review','failed']),
  failed:new Set(['retry_scheduled','cancelled'])
};
const terminal=new Set(['completed','cancelled','expired']);

function principalKey(p:any){return String(p?.identityId??p?.actorId??p?.email??p?.role??'anonymous');}
function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

export async function caseKernelRoutes(app:FastifyInstance){
  app.post('/api/core/cases',{preHandler:requireRole('customer','admin','partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    const body=createBody.parse(req.body); const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
    if(!key)return reply.code(400).send({error:'idempotency_key_required'});
    const client=await pool.connect();
    try{
      await client.query('begin');
      const pk=principalKey(req.principal), requestHash=hash(body);
      const prior=await client.query('select request_hash,response_status,response_body from core_command_idempotency where principal_id=$1 and idempotency_key=$2 and command_name=$3 for update',[pk,key,'case.create']);
      if(prior.rowCount){
        if(prior.rows[0].request_hash!==requestHash){await client.query('rollback');return reply.code(409).send({error:'idempotency_key_reused'});}
        await client.query('commit'); return reply.code(prior.rows[0].response_status??201).send(prior.rows[0].response_body);
      }
      const customerActorId=req.principal.role==='customer'?req.principal.actorId:null;
      const r=await client.query(`insert into core_cases(case_type,market_id,location_id,customer_actor_id,priority,requirements,constraints,attributes)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[body.caseType,body.marketId??null,body.locationId??null,customerActorId,body.priority,body.requirements,body.constraints,body.attributes]);
      const c=r.rows[0], correlationId=randomUUID();
      await client.query(`insert into core_case_events(case_id,actor_id,event_type,correlation_id,payload,payload_hash,previous_version,new_version)
        values($1,$2,'CASE_CREATED',$3,$4,$5,0,1)`,[c.id,req.principal.actorId??null,correlationId,{caseType:c.case_type,state:c.state},hash({caseType:c.case_type,state:c.state})]);
      await client.query(`insert into core_outbox(aggregate_type,aggregate_id,event_type,payload,correlation_id) values('case',$1,'CASE_CREATED',$2,$3)`,[c.id,{caseId:c.id,caseType:c.case_type,state:c.state},correlationId]);
      const response={case:c};
      await client.query('insert into core_command_idempotency(principal_id,idempotency_key,command_name,request_hash,response_status,response_body) values($1,$2,$3,$4,201,$5)',[pk,key,'case.create',requestHash,response]);
      await client.query('commit'); return reply.code(201).send(response);
    }catch(e){await client.query('rollback');throw e;}finally{client.release();}
  });

  app.get('/api/core/cases/:id',async(req,reply)=>{
    const {id}=req.params as {id:string}; const r=await pool.query('select * from core_cases where id=$1',[id]);
    if(!r.rowCount)return reply.code(404).send({error:'case_not_found'});
    const c=r.rows[0]; if(req.principal.role==='customer'&&c.customer_actor_id!==req.principal.actorId)return reply.code(403).send({error:'forbidden'});
    const events=await pool.query('select id,event_type,actor_id,correlation_id,causation_id,schema_version,payload,previous_version,new_version,occurred_at from core_case_events where case_id=$1 order by occurred_at,id',[id]);
    return {case:c,events:events.rows};
  });

  app.post('/api/core/cases/:id/transition',{preHandler:requireRole('admin','partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    const {id}=req.params as {id:string}; const body=transitionBody.parse(req.body); const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
    if(!key)return reply.code(400).send({error:'idempotency_key_required'});
    const client=await pool.connect();
    try{
      await client.query('begin'); const pk=principalKey(req.principal), requestHash=hash(body);
      const prior=await client.query('select request_hash,response_status,response_body from core_command_idempotency where principal_id=$1 and idempotency_key=$2 and command_name=$3 for update',[pk,key,`case.transition:${id}`]);
      if(prior.rowCount){if(prior.rows[0].request_hash!==requestHash){await client.query('rollback');return reply.code(409).send({error:'idempotency_key_reused'});}await client.query('commit');return reply.code(prior.rows[0].response_status??200).send(prior.rows[0].response_body);}
      const q=await client.query('select * from core_cases where id=$1 for update',[id]); if(!q.rowCount){await client.query('rollback');return reply.code(404).send({error:'case_not_found'});}
      const c=q.rows[0]; if(Number(c.version)!==body.expectedVersion){await client.query('rollback');return reply.code(409).send({error:'version_conflict',currentVersion:Number(c.version),state:c.state});}
      if(terminal.has(c.state)){await client.query('rollback');return reply.code(409).send({error:'terminal_case',state:c.state});}
      if(!(allowed[c.state]?.has(body.requestedTransition))){await client.query('rollback');return reply.code(422).send({error:'transition_not_allowed',from:c.state,to:body.requestedTransition});}
      const nextVersion=Number(c.version)+1, correlationId=body.correlationId??randomUUID(), now=new Date();
      const done=body.requestedTransition==='completed'?now:null, cancelled=body.requestedTransition==='cancelled'?now:null;
      const u=await client.query('update core_cases set state=$2,version=$3,updated_at=$4,completed_at=coalesce($5,completed_at),cancelled_at=coalesce($6,cancelled_at) where id=$1 returning *',[id,body.requestedTransition,nextVersion,now,done,cancelled]);
      const payload={from:c.state,to:body.requestedTransition,evidence:body.evidence};
      await client.query(`insert into core_case_events(case_id,actor_id,event_type,correlation_id,payload,payload_hash,previous_version,new_version)
        values($1,$2,'CASE_TRANSITIONED',$3,$4,$5,$6,$7)`,[id,req.principal.actorId??null,correlationId,payload,hash(payload),body.expectedVersion,nextVersion]);
      await client.query(`insert into core_outbox(aggregate_type,aggregate_id,event_type,payload,correlation_id) values('case',$1,'CASE_TRANSITIONED',$2,$3)`,[id,{caseId:id,...payload,version:nextVersion},correlationId]);
      const response={case:u.rows[0]};
      await client.query('insert into core_command_idempotency(principal_id,idempotency_key,command_name,request_hash,response_status,response_body) values($1,$2,$3,$4,200,$5)',[pk,key,`case.transition:${id}`,requestHash,response]);
      await client.query('commit'); return reply.send(response);
    }catch(e){await client.query('rollback');throw e;}finally{client.release();}
  });
}
