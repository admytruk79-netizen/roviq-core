import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { decideCoreApproval, listCoreApprovals, requestCoreApproval } from '../../services/core-approvals.js';
import { coreToolRegistry, invokeCoreTool } from '../../services/core-tools.js';

function mapError(error:unknown,reply:FastifyReply){
  const m=error instanceof Error?error.message:'operation_failed';
  if(m==='forbidden'||m==='tool_forbidden')return reply.code(403).send({error:m});
  if(m.endsWith('_not_found')||m==='case_not_found')return reply.code(404).send({error:m});
  if(m==='approval_already_decided'||m==='approval_expired')return reply.code(409).send({error:m});
  return reply.code(400).send({error:m});
}

export async function coreApprovalToolRoutes(app:FastifyInstance){
  app.get('/api/core/cases/:id/approvals',async(req,reply)=>{
    const {id}=req.params as {id:string};
    try{return{approvals:await listCoreApprovals(req.principal,id)};}catch(e){return mapError(e,reply);}
  });

  app.post('/api/core/cases/:id/approvals',{preHandler:requireRole('admin','partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const b=z.object({
      approvalType:z.string().min(1).max(100),
      action:z.string().min(1).max(120),
      requestedFromActorId:z.string().uuid(),
      payload:z.record(z.unknown()).default({}),
      expiresAt:z.string().datetime().optional()
    }).parse(req.body);
    try{
      const approval=await requestCoreApproval({
        principal:req.principal,caseId:id,approvalType:b.approvalType,action:b.action,
        requestedFromActorId:b.requestedFromActorId,payload:b.payload,expiresAt:b.expiresAt?new Date(b.expiresAt):null
      });
      return reply.code(201).send({approval});
    }catch(e){return mapError(e,reply);}
  });

  app.post('/api/core/cases/:id/approvals/:approvalId/decision',async(req,reply)=>{
    const {id,approvalId}=req.params as {id:string;approvalId:string};
    const b=z.object({decision:z.enum(['approved','rejected']),reason:z.string().max(1000).optional()}).parse(req.body);
    const client=await pool.connect();
    try{
      await client.query('begin');
      const approval=await decideCoreApproval({principal:req.principal,caseId:id,approvalId,decision:b.decision,reason:b.reason},client);
      await client.query('commit');
      return{approval};
    }catch(e){
      await client.query('rollback');
      return mapError(e,reply);
    }finally{client.release();}
  });

  app.get('/api/core/tools',async(req)=>({
    tools:coreToolRegistry.filter(t=>t.roles.includes(req.principal.role)).map(({name,description,mutates})=>({name,description,mutates}))
  }));

  app.post('/api/core/tools/:name/invoke',async(req,reply)=>{
    const {name}=req.params as {name:string};
    const b=z.object({args:z.record(z.unknown()).default({})}).parse(req.body);
    try{return await invokeCoreTool({principal:req.principal,toolName:name,args:b.args});}
    catch(e){return mapError(e,reply);}
  });
}
