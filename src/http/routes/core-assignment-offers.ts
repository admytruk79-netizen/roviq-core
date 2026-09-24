import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { withIdempotency } from '../../services/idempotency.js';
import {
  createAssignmentOffer,listAssignmentOffersForActor,listAssignmentOffersForCase,respondToAssignmentOffer
} from '../../services/core-assignment-offers.js';

function mapError(error:unknown,reply:FastifyReply){
  const m=error instanceof Error?error.message:'assignment_offer_failed';
  if(['forbidden','policy_denied'].includes(m))return reply.code(403).send({error:m});
  if(['case_not_found','actor_not_found','assignment_offer_not_found'].includes(m))return reply.code(404).send({error:m});
  if([
    'version_conflict','terminal_case','actor_not_active','actor_not_assignable','actor_already_owner',
    'policy_review_required','assignment_offer_not_pending','assignment_offer_expired','assignment_offer_stale'
  ].includes(m))return reply.code(409).send({error:m});
  return reply.code(400).send({error:m});
}

export async function coreAssignmentOfferRoutes(app:FastifyInstance){
  app.get('/api/core/me/assignment-offers',{preHandler:requireRole('partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    try{return{offers:await listAssignmentOffersForActor(req.principal)};}
    catch(e){return mapError(e,reply);}
  });

  app.get('/api/core/cases/:id/assignment-offers',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    try{return{offers:await listAssignmentOffersForCase(req.principal,id)};}
    catch(e){return mapError(e,reply);}
  });

  app.post('/api/core/cases/:id/assignment-offers',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const body=z.object({
      actorId:z.string().uuid(),
      expectedVersion:z.number().int().positive(),
      reason:z.string().max(1000).optional(),
      expiresInMinutes:z.number().int().min(1).max(120).default(15),
      metadata:z.record(z.unknown()).default({})
    }).parse(req.body);
    const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
    if(!key)return reply.code(400).send({error:'idempotency_key_required'});
    try{
      const result=await withIdempotency(req.principal,key,`core.assignment.offer:${id}`,body,async(client)=>{
        if(!client)throw new Error('transaction_required');
        const created=await createAssignmentOffer({
          principal:req.principal,caseId:id,actorId:body.actorId,expectedVersion:body.expectedVersion,
          reason:body.reason,expiresInMinutes:body.expiresInMinutes,metadata:body.metadata
        },client);
        return{status:201,body:created};
      });
      return reply.code(result.status).send(result.body);
    }catch(e){return mapError(e,reply);}
  });

  app.post('/api/core/assignment-offers/:id/respond',{preHandler:requireRole('partner','diagnostic','tow','parts','fleet')},async(req,reply)=>{
    const {id}=req.params as {id:string};
    const body=z.object({decision:z.enum(['accepted','declined']),reason:z.string().max(1000).optional()}).parse(req.body);
    const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined;
    if(!key)return reply.code(400).send({error:'idempotency_key_required'});
    try{
      const result=await withIdempotency(req.principal,key,`core.assignment.offer.respond:${id}`,body,async(client)=>{
        if(!client)throw new Error('transaction_required');
        const response=await respondToAssignmentOffer({principal:req.principal,offerId:id,decision:body.decision,reason:body.reason},client);
        return{status:200,body:response};
      });
      return reply.code(result.status).send(result.body);
    }catch(e){return mapError(e,reply);}
  });
}
