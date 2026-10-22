import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import {
  claimOpenJob, listOpenJobs, openJobForCase, publishOpenJob, rateProvider, rateableProviders, technicianStanding, withdrawOpenJob
} from '../../services/open-jobs.js';
import { audit } from '../../services/audit.js';
import { QualificationBlockedError } from '../../services/qualification-gate.js';

// Open job board: Ops opens a case to nearby technicians, better-ranked technicians see better jobs
// first, first claim wins. Customers rate the providers who worked their case, which feeds the rank.

const STATUS: Record<string, number> = {
  case_not_found: 404, open_job_not_found: 404, provider_not_on_case: 404,
  forbidden: 403, open_job_too_far: 403,
  location_required: 400,
  open_job_location_missing: 422,
  open_job_taken: 409, open_job_not_yet_available: 409, case_has_live_offer: 409, case_not_open_for_diagnostics: 409, rating_too_early: 409
};

function mapped(reply: FastifyReply, error: unknown) {
  if (error instanceof QualificationBlockedError) return reply.code(403).send({ error: 'qualification_required' });
  const message = error instanceof Error ? error.message : '';
  const status = STATUS[message];
  if (!status) throw error;
  return reply.code(status).send({ error: message });
}

const point = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });
const here = (value: unknown) => { const p = point.safeParse(value); return p.success ? p.data : null; };
const caseParams = z.object({ id: z.string().uuid() });

export async function openJobRoutes(app: FastifyInstance) {
  app.get('/api/diagnostics/open-jobs', { preHandler: requireRole('diagnostic') }, async (req, reply) => {
    try { return await listOpenJobs(req.principal, here(req.query)); } catch (error) { return mapped(reply, error); }
  });

  app.post('/api/diagnostics/open-jobs/:id/claim', { preHandler: requireRole('diagnostic') }, async (req, reply) => {
    const { id } = caseParams.parse(req.params);
    try { return reply.code(201).send({ claim: await claimOpenJob(req.principal, id, here(req.body)) }); } catch (error) { return mapped(reply, error); }
  });

  app.get('/api/diagnostics/me/standing', { preHandler: requireRole('diagnostic') }, async (req) => {
    return { standing: await technicianStanding(req.principal.actorId!) };
  });

  app.get('/api/admin/cases/:id/open-job', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = caseParams.parse(req.params);
    return { openJob: await openJobForCase(id) };
  });

  app.post('/api/admin/cases/:id/open-job', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = caseParams.parse(req.params);
    try { return reply.code(201).send({ openJob: await publishOpenJob(req.principal, id) }); } catch (error) { return mapped(reply, error); }
  });

  app.delete('/api/admin/cases/:id/open-job', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = caseParams.parse(req.params);
    const withdrawn = await withdrawOpenJob(id, 'ops_withdrew');
    if (!withdrawn) return reply.code(404).send({ error: 'open_job_not_found' });
    await audit(req.principal, 'withdraw_open_job', 'open_job', withdrawn.id, 'open_job_board', { caseId: id });
    return { openJob: withdrawn };
  });

  app.get('/api/maintenance/cases/:id/ratings', { preHandler: requireRole('customer') }, async (req, reply) => {
    const { id } = caseParams.parse(req.params);
    try { return { providers: await rateableProviders(req.principal, id) }; } catch (error) { return mapped(reply, error); }
  });

  app.post('/api/maintenance/cases/:id/ratings', { preHandler: requireRole('customer') }, async (req, reply) => {
    const { id } = caseParams.parse(req.params);
    const body = z.object({ actorId: z.string().uuid(), stars: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }).parse(req.body);
    try { return reply.code(201).send({ rating: await rateProvider(req.principal, id, body.actorId, body.stars, body.comment) }); } catch (error) { return mapped(reply, error); }
  });
}
