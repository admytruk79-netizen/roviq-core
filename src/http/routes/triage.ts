import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { createTriageAssessment, decideTriageAction, getCaseTriage, reviewTriageAssessment } from '../../services/triage.js';
import { runTriage } from '../../services/triage-engine.js';
import { requireRole } from '../middleware/principal.js';
import { assertCaseAccess, loadCaseForPrincipal } from '../../services/case-access.js';

export async function triageRoutes(app: FastifyInstance) {
  app.post('/api/maintenance/cases/:id/triage/run', { preHandler: requireRole('customer','admin','diagnostic','partner') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({
      symptoms:z.string().min(3).max(5000),
      vehicle:z.record(z.unknown()).optional(),
      observations:z.record(z.unknown()).optional(),
      mode:z.enum(['shadow','advisory','assisted']).optional()
    }).parse(req.body);
    try { return reply.code(201).send(await runTriage(req.principal,{ caseId:id,...body })); }
    catch (e) {
      const message = e instanceof Error ? e.message : 'triage_failed';
      if (message === 'case_not_found') return reply.code(404).send({ error:message });
      if (message === 'forbidden') return reply.code(403).send({ error:message });
      throw e;
    }
  });

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
    try {
      const c = await loadCaseForPrincipal(req.principal,id);
      if (!c) return reply.code(404).send({ error:'case_not_found' });
      return getCaseTriage(id);
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden') return reply.code(403).send({error:'forbidden'});
      throw error;
    }
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

  app.post('/api/triage/:id/outcome', { preHandler: requireRole('admin','diagnostic','partner') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({
      confirmedDrivability:z.enum(['unknown','drivable','limited','non_drivable']).optional(),
      confirmedCapabilities:z.array(z.string()).default([]),
      confirmedFaultCategory:z.string().optional(),
      towRequired:z.boolean().optional(),
      safetyCritical:z.boolean().optional(),
      diagnosticSummary:z.string().optional(),
      repairSummary:z.string().optional(),
      metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    const a = await pool.query('select id,case_id from ai_triage_assessments where id=$1',[id]);
    if (!a.rowCount) return reply.code(404).send({ error:'assessment_not_found' });
    try { await assertCaseAccess(req.principal,a.rows[0].case_id); }
    catch (error) {
      if (error instanceof Error && error.message === 'forbidden') return reply.code(403).send({error:'forbidden'});
      throw error;
    }
    const r = await pool.query(
      `insert into ai_triage_outcomes(assessment_id,case_id,confirmed_drivability,confirmed_capabilities,confirmed_fault_category,tow_required,safety_critical,diagnostic_summary,repair_summary,labeled_by_actor_id,metadata)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict(assessment_id) do update set confirmed_drivability=excluded.confirmed_drivability,confirmed_capabilities=excluded.confirmed_capabilities,confirmed_fault_category=excluded.confirmed_fault_category,tow_required=excluded.tow_required,safety_critical=excluded.safety_critical,diagnostic_summary=excluded.diagnostic_summary,repair_summary=excluded.repair_summary,labeled_by_actor_id=excluded.labeled_by_actor_id,labeled_at=now(),metadata=excluded.metadata returning *`,
      [id,a.rows[0].case_id,body.confirmedDrivability ?? null,JSON.stringify(body.confirmedCapabilities),body.confirmedFaultCategory ?? null,body.towRequired ?? null,body.safetyCritical ?? null,body.diagnosticSummary ?? null,body.repairSummary ?? null,req.principal.actorId ?? null,JSON.stringify(body.metadata ?? {})]
    );
    return reply.code(201).send({ outcome:r.rows[0] });
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
