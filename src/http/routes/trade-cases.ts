import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { withIdempotency } from '../../services/idempotency.js';
import { addTradeDocument, advanceTradePhase, createTradeCase, loadTradeCase, setTradeMilestone, tradePhaseTransitions, type TradePhase } from '../../services/trade-case.js';

function err(error:unknown,reply:FastifyReply){
  const m=error instanceof Error?error.message:'trade_operation_failed';
  if(m==='forbidden')return reply.code(403).send({error:m});
  if(m.includes('not_found')||m==='case_not_found')return reply.code(404).send({error:m});
  if(['trade_phase_not_allowed','trade_milestone_incomplete','version_conflict','policy_review_required','approval_missing','approval_not_found','approval_stale','approval_expired','approval_action_mismatch'].includes(m))return reply.code(409).send({error:m});
  if(m==='policy_denied')return reply.code(403).send({error:m});
  return reply.code(400).send({error:m});
}

export async function tradeCaseRoutes(app:FastifyInstance){
  app.post('/api/core/trade-cases',{preHandler:requireRole('customer','admin','partner')},async(req,reply)=>{
    const b=z.object({
      tradeMode:z.enum(['export','import']),
      originCountry:z.string().min(2).max(100),
      destinationCountry:z.string().min(2).max(100),
      originLocation:z.string().max(250).optional(),
      destinationLocation:z.string().max(250).optional(),
      subject:z.record(z.unknown()).default({}),
      marketId:z.string().uuid().optional(),
      locationId:z.string().uuid().optional(),
      priority:z.enum(['low','normal','high','urgent']).default('normal')
    }).parse(req.body);
    const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
    if(!key)return reply.code(400).send({error:'idempotency_key_required'});
    try{
      const result=await withIdempotency(req.principal,key,'trade.case.create',b,async(client)=>{
        if(!client)throw new Error('transaction_required');
        const created=await createTradeCase({principal:req.principal,...b},client);
        return{status:201,body:created};
      });
      return reply.code(result.status).send(result.body);
    }catch(e){return err(e,reply);}
  });

  app.get('/api/core/trade-cases/:id',async(req,reply)=>{
    const {id}=req.params as {id:string};
    try{const trade=await loadTradeCase(req.principal,id);if(!trade)return reply.code(404).send({error:'case_not_found'});return trade;}
    catch(e){return err(e,reply);}
  });

  app.get('/api/core/trade-cases/:id/phase-actions',async(req,reply)=>{
    const {id}=req.params as {id:string};
    try{
      const trade=await loadTradeCase(req.principal,id);
      if(!trade)return reply.code(404).send({error:'case_not_found'});
      const phase=trade.trade.phase as TradePhase;
      return {
        caseId:id,
        phase,
        version:Number(trade.case.version),
        transitions:tradePhaseTransitions(phase).map(to=>({
          to,
          action:`trade.phase:${to}`,
          approvalRecommended:to==='completed'
        }))
      };
    }catch(e){return err(e,reply);}
  });

  app.post('/api/core/trade-cases/:id/phase',{preHandler:requireRole('admin','partner')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const b=z.object({
      to:z.enum(['sourcing','verification','commercial_quote','approval','compliance_documents','freight_booking','in_transit','destination_handoff','completed','cancelled']),
      expectedVersion:z.number().int().positive(),
      approvalId:z.string().uuid().optional(),
      evidence:z.record(z.unknown()).default({})
    }).parse(req.body);
    const client=await pool.connect();
    try{await client.query('begin');const trade=await advanceTradePhase({principal:req.principal,caseId:id,to:b.to,expectedVersion:b.expectedVersion,approvalId:b.approvalId,evidence:b.evidence},client);await client.query('commit');return{trade};}
    catch(e){await client.query('rollback');return err(e,reply);}finally{client.release();}
  });

  app.post('/api/core/trade-cases/:id/milestones/:code',{preHandler:requireRole('admin','partner')},async(req,reply)=>{
    const {id,code}=req.params as {id:string;code:string};
    const b=z.object({state:z.enum(['ready','completed','blocked','waived']),evidence:z.record(z.unknown()).default({})}).parse(req.body);
    const client=await pool.connect();
    try{await client.query('begin');const milestone=await setTradeMilestone({principal:req.principal,caseId:id,milestoneCode:code,state:b.state,evidence:b.evidence},client);await client.query('commit');return{milestone};}
    catch(e){await client.query('rollback');return err(e,reply);}finally{client.release();}
  });

  app.post('/api/core/trade-cases/:id/documents',{preHandler:requireRole('admin','partner')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const b=z.object({documentType:z.string().min(1).max(120),externalReference:z.string().max(500).optional(),metadata:z.record(z.unknown()).default({})}).parse(req.body);
    try{return reply.code(201).send({document:await addTradeDocument({principal:req.principal,caseId:id,...b})});}
    catch(e){return err(e,reply);}
  });
}
