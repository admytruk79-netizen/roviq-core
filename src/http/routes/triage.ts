import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { createTriageAssessment, decideTriageAction, getCaseTriage, reviewTriageAssessment } from '../../services/triage.js';
import { requireRole } from '../middleware/principal.js';

export async function triageRoutes(app: FastifyInstance) {
  app.post('/api/maintenance/cases/:id/triage', { preHandler: requireRole('customer','admin','diagnostic','partner') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({
      demandId:z.string().uuid().optional(), source:z.string().default('ai'), modelProvider:z.string().optional(), modelName:z.string().optional(),
      inputSnapshot:z.record(z.unknown()).optional(), symptomSummary:z.string().optional(), suggestedCapabilities:z.array(z.string()).optional(),
      suggestedDrivability:z.enum(['unknown','drivable','limited','non_drivable']).optional(), safetyFlags:z.array(z.unknown()).optional(),
      evidence:z.array(z.unknown()).optional(), confidence:z.number().min(0).max(1).optional(), requiresHumanReview:z.boolean().default(true),
      actions:z.array(z.object({ actionType:z.string().min(1), actionPayload:z.record(z.unknown()).optional() })).optional()
    }).parse(req.body);
    try {
      const assessment = await createTriageAssessment(req.principal,{ caseId:id,...body });
      return reply.code(201).send({ assessment });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'triage_failed';
      if (message === 'case_not_found') return reply.code(404).send({ error:message });
      if (message === 'forbidden') return reply.code(403).send({ error:message });
      throw e;
    }
  });

  app.get('/api/maintenance/cases/:id/triage', async (req, reply) => {
    const { id } = req.params as { id:string };
    const c = await pool.query('select customer_actor_id,current_owner_actor_id from service_cases where id=$1',[id]);
    if (!c.rowCount) return reply.code(404).send({ error:'case_not_found' });
    if (req.principal.role === 'customer' && c.rows[0].customer_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'forbidden' });
    if (!['admin','customer'].includes(req.principal.role) && c.rows[0].current_owner_actor_id && c.rows[0].current_owner_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'forbidden' });
    return getCaseTriage(id);
  });

  app.post('/api/triage/:id/review', { preHandler: requireRole('admin','diagnostic','partner') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ decision:z.enum(['accepted','rejected']), notes:z.string().optional() }).parse(req.body);
    try { return { assessment:await reviewTriageAssessment(req.principal,id,body.decision,body.notes) }; }
    catch (e) {
      const message = e instanceof Error ? e.message : 'review_failed';
      if (message === 'assessment_not_found') return reply.code(404).send({ error:message });
      if (message === 'forbidden') return reply.code(403).send({ error:message });
      if (message === 'assessment_already_final') return reply.code(409).send({ error:message });
      throw e;
    }
  });

  app.post('/api/triage/actions/:id/decision', { preHandler: requireRole('admin','diagnostic','partner') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ decision:z.enum(['approved','rejected']) }).parse(req.body);
    try { return { action:await decideTriageAction(req.principal,id,body.decision) }; }
    catch (e) {
      const message = e instanceof Error ? e.message : 'action_review_failed';
      if (message === 'action_not_found') return reply.code(404).send({ error:message });
      if (message === 'forbidden') return reply.code(403).send({ error:message });
      if (message === 'action_already_decided') return reply.code(409).send({ error:message });
      throw e;
    }
  });
}
