import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { decideApproval, getServicePlan, reviseServicePlan } from '../../services/service-plan.js';

const revisionBody = z.object({
  changeReason:z.string().min(3).max(1000),
  customerSummary:z.string().min(1).max(4000).optional(),
  estimatedTotalMinor:z.number().int().nonnegative().optional(),
  currency:z.string().length(3).transform((value)=>value.toUpperCase()).optional(),
  tasks:z.array(z.object({
    taskType:z.string().min(1).max(100),
    title:z.string().min(1).max(500),
    instructions:z.string().max(4000).optional(),
    dueAt:z.string().datetime().optional(),
    estimatedAmountMinor:z.number().int().nonnegative().optional(),
    currency:z.string().length(3).transform((value)=>value.toUpperCase()).optional(),
    metadata:z.record(z.unknown()).optional()
  })).max(100).optional()
});

async function createRevision(req:any, reply:any) {
  const { id } = req.params as { id:string };
  const body = revisionBody.parse(req.body);
  try {
    const plan = await reviseServicePlan(req.principal,id,body);
    return reply.code(201).send({plan});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'service_plan_revision_failed';
    if (message === 'case_not_found' || message === 'service_plan_not_found') return reply.code(404).send({error:message});
    if (message === 'forbidden') return reply.code(403).send({error:message});
    throw error;
  }
}

export async function servicePlanRoutes(app:FastifyInstance) {
  app.get('/api/maintenance/cases/:id/service-plan', async (req,reply) => {
    const { id } = req.params as { id:string };
    try {
      const result = await getServicePlan(req.principal,id);
      if (!result) return reply.code(404).send({error:'service_plan_not_found'});
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'service_plan_failed';
      if (message === 'case_not_found' || message === 'service_plan_not_found') return reply.code(404).send({error:message});
      if (message === 'forbidden') return reply.code(403).send({error:message});
      throw error;
    }
  });

  app.post('/api/admin/maintenance/cases/:id/service-plan/revisions', { preHandler:requireRole('admin') }, createRevision);
  app.post('/api/maintenance/cases/:id/service-plan/revisions', { preHandler:requireRole('partner') }, createRevision);

  app.post('/api/maintenance/cases/:id/approvals/:approvalId/decision', async (req, reply) => {
    const { id, approvalId } = req.params as { id:string; approvalId:string };
    const body = z.object({ decision:z.enum(['approved','rejected']), reason:z.string().max(1000).optional() }).parse(req.body);
    try {
      const approval = await decideApproval(req.principal,id,approvalId,body.decision,body.reason);
      return { approval };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'approval_decision_failed';
      if (message === 'case_not_found' || message === 'approval_not_found') return reply.code(404).send({error:message});
      if (message === 'forbidden') return reply.code(403).send({error:message});
      if (message === 'approval_already_decided') return reply.code(409).send({error:message});
      throw error;
    }
  });
}
