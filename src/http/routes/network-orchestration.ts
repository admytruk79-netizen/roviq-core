import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { generateFulfillmentPlan, getLatestFulfillmentPlan } from '../../services/fulfillment-planner.js';
import { evaluateFulfillmentCompletion } from '../../services/network-execution.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';

export async function networkOrchestrationRoutes(app:FastifyInstance){
  app.post('/api/admin/maintenance/cases/:caseId/fulfillment-plan',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {caseId}=z.object({caseId:z.string().uuid()}).parse(req.params);
    const serviceCase=await loadCaseForPrincipal(req.principal,caseId);
    if(!serviceCase) return reply.code(404).send({error:'case_not_found'});
    const result=await generateFulfillmentPlan(req.principal,caseId);
    return reply.code(201).send(result);
  });

  app.get('/api/admin/maintenance/cases/:caseId/fulfillment-plan',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {caseId}=z.object({caseId:z.string().uuid()}).parse(req.params);
    const serviceCase=await loadCaseForPrincipal(req.principal,caseId);
    if(!serviceCase) return reply.code(404).send({error:'case_not_found'});
    const result=await getLatestFulfillmentPlan(caseId);
    if(!result) return reply.code(404).send({error:'fulfillment_plan_not_found'});
    return result;
  });
  app.get('/api/admin/maintenance/cases/:caseId/fulfillment-readiness',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {caseId}=z.object({caseId:z.string().uuid()}).parse(req.params);
    const serviceCase=await loadCaseForPrincipal(req.principal,caseId);
    if(!serviceCase) return reply.code(404).send({error:'case_not_found'});
    return evaluateFulfillmentCompletion(caseId);
  });

  app.post('/api/admin/maintenance/cases/:caseId/fulfillment-plan/recover',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {caseId}=z.object({caseId:z.string().uuid()}).parse(req.params);
    const serviceCase=await loadCaseForPrincipal(req.principal,caseId);
    if(!serviceCase) return reply.code(404).send({error:'case_not_found'});
    const latest=await getLatestFulfillmentPlan(caseId);
    if(!latest) return reply.code(404).send({error:'fulfillment_plan_not_found'});
    if(!latest.plan.recovery_required_at&&latest.plan.status!=='blocked'){
      return reply.code(409).send({error:'fulfillment_recovery_not_required'});
    }
    const result=await generateFulfillmentPlan(req.principal,caseId);
    return reply.code(201).send(result);
  });

}
