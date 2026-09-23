import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { withIdempotency } from '../../services/idempotency.js';
import { loadCoreCaseForPrincipal } from '../../services/core-case-access.js';
import { evaluateCorePolicy } from '../../services/core-policy.js';
import { validateCoreApprovalEvidence } from '../../services/core-approvals.js';

const caseType=z.enum(['maintenance','transport','mobility','fleet','trade']);
const createBody=z.object({
  caseType, marketId:z.string().uuid().optional(), locationId:z.string().uuid().optional(),
  priority:z.enum(['low','normal','high','urgent']).default('normal'),
  requirements:z.record(z.unknown()).default({}), constraints:z.record(z.unknown()).default({}),
  attributes:z.record(z.unknown()).default({})
});
const transitionBody=z.object({
  expectedVersion:z.number().int().positive(), requestedTransition:z.string().min(1).max(80),
  evidence:z.record(z.unknown()).default({}), approvalId:z.string().uuid().optional(), correlationId:z.string().uuid().optional()
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
function hash(value:unknown){return createHash('sha256').update(stableJson(value)).digest('hex');}
function stableJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object'){const r=value as Record<string,unknown>;return `{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${stableJson(r[k])}`).join(',')}}`;}
  return JSON.stringify(value)??'null';
}

export async function caseKernelRoutes(app:FastifyInstance){
  app.post('/api/core/cases',{preHandler:requireRole('customer','admin','partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    const body=createBody.parse(req.body);
    const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
    if(!key)return reply.code(400).send({error:'idempotency_key_required'});
    const result=await withIdempotency(req.principal,key,'core.case.create',body,async(client)=>{
      if(!client)throw new Error('transaction_required');
      const customerActorId=req.principal.role==='customer'?req.principal.actorId:null;
      const r=await client.query(`insert into core_cases(case_type,market_id,location_id,customer_actor_id,priority,requirements,constraints,attributes)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[body.caseType,body.marketId??null,body.locationId??null,customerActorId,body.priority,body.requirements,body.constraints,body.attributes]);
      const c=r.rows[0], correlationId=randomUUID(), payload={caseType:c.case_type,state:c.state};
      await client.query(`insert into core_case_events(case_id,actor_id,event_type,correlation_id,payload,payload_hash,previous_version,new_version)
        values($1,$2,'CASE_CREATED',$3,$4,$5,0,1)`,[c.id,req.principal.actorId??null,correlationId,payload,hash(payload)]);
      await client.query(`insert into core_outbox(aggregate_type,aggregate_id,event_type,payload,correlation_id) values('case',$1,'CASE_CREATED',$2,$3)`,[c.id,{caseId:c.id,...payload},correlationId]);
      return {status:201,body:{case:c}};
    });
    return reply.code(result.status).send(result.body);
  });

  app.get('/api/core/cases/:id',async(req,reply)=>{
    const {id}=req.params as {id:string};
    try{
      const c=await loadCoreCaseForPrincipal(req.principal,id);
      if(!c)return reply.code(404).send({error:'case_not_found'});
      const events=await pool.query('select id,event_type,actor_id,correlation_id,causation_id,schema_version,payload,previous_version,new_version,occurred_at from core_case_events where case_id=$1 order by new_version,id',[id]);
      return {case:c,events:events.rows};
    }catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
  });

  app.post('/api/core/cases/:id/transition',{preHandler:requireRole('admin','partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    const {id}=req.params as {id:string}; const body=transitionBody.parse(req.body);
    const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
    if(!key)return reply.code(400).send({error:'idempotency_key_required'});
    try{
      const result=await withIdempotency(req.principal,key,`core.case.transition:${id}`,body,async(client)=>{
        if(!client)throw new Error('transaction_required');
        const c=await loadCoreCaseForPrincipal(req.principal,id,client);
        if(!c)return {status:404,body:{error:'case_not_found'} as Record<string,unknown>};
        const q=await client.query('select * from core_cases where id=$1 for update',[id]);
        const locked=q.rows[0];
        if(Number(locked.version)!==body.expectedVersion)return {status:409,body:{error:'version_conflict',currentVersion:Number(locked.version),state:locked.state}};
        if(terminal.has(locked.state))return {status:409,body:{error:'terminal_case',state:locked.state}};
        if(!(allowed[locked.state]?.has(body.requestedTransition)))return {status:422,body:{error:'transition_not_allowed',from:locked.state,to:body.requestedTransition}};
        const approval=await validateCoreApprovalEvidence({
          caseId:id,approvalId:body.approvalId,action:`case.transition:${body.requestedTransition}`,expectedCaseVersion:body.expectedVersion
        },client);
        const policy=await evaluateCorePolicy({
          action:'case.transition',principal:req.principal,caseRecord:locked,toState:body.requestedTransition,
          facts:{evidence:body.evidence,approval}
        },client);
        if(policy.decision==='deny')return {status:403,body:{error:'policy_denied',reason:policy.reason,matchedRules:policy.matchedRules}};
        if(policy.decision==='require_review')return {status:409,body:{error:'policy_review_required',reason:policy.reason,matchedRules:policy.matchedRules}};
        const nextVersion=Number(locked.version)+1, correlationId=body.correlationId??randomUUID(), now=new Date();
        const done=body.requestedTransition==='completed'?now:null, cancelled=body.requestedTransition==='cancelled'?now:null;
        const u=await client.query('update core_cases set state=$2,version=$3,updated_at=$4,completed_at=coalesce($5,completed_at),cancelled_at=coalesce($6,cancelled_at) where id=$1 and version=$7 returning *',[id,body.requestedTransition,nextVersion,now,done,cancelled,body.expectedVersion]);
        if(!u.rowCount)return {status:409,body:{error:'version_conflict'}};
        const payload={from:locked.state,to:body.requestedTransition,evidence:body.evidence,approval:approval.valid?approval.approval:null};
        await client.query(`insert into core_case_events(case_id,actor_id,event_type,correlation_id,payload,payload_hash,previous_version,new_version)
          values($1,$2,'CASE_TRANSITIONED',$3,$4,$5,$6,$7)`,[id,req.principal.actorId??null,correlationId,payload,hash(payload),body.expectedVersion,nextVersion]);
        await client.query(`insert into core_outbox(aggregate_type,aggregate_id,event_type,payload,correlation_id) values('case',$1,'CASE_TRANSITIONED',$2,$3)`,[id,{caseId:id,...payload,version:nextVersion},correlationId]);
        return {status:200,body:{case:u.rows[0]}};
      });
      return reply.code(result.status).send(result.body);
    }catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
  });
}
