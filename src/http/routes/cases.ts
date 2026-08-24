import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { createDeadline, createServiceCase, getCaseTimeline, raiseException, transitionCase, withIdempotency } from '../../services/orchestration.js';
import { addLedgerEntry, setCustomerSnapshot, sweepExpiredDeadlines } from '../../services/operations.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';

const createCaseBody = z.object({
  demandId: z.string().uuid().optional(),
  marketId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  priority: z.enum(['low','normal','high','urgent']).optional(),
  drivability: z.enum(['unknown','drivable','limited','non_drivable']).optional(),
  attributes: z.record(z.unknown()).optional()
});

const state = z.enum(['intake','triage','diagnostic_pending','diagnostic_in_progress','tow_pending','tow_in_progress','provider_selection','provider_pending','repair_in_progress','parts_pending','payment_pending','completed','cancelled']);

export async function caseRoutes(app: FastifyInstance) {
  app.post('/api/maintenance/cases', { preHandler: requireRole('customer','admin') }, async (req, reply) => {
    const body = createCaseBody.parse(req.body);
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
    const result = await withIdempotency(req.principal,key,'create_service_case',body,async (client) => {
      const c = await createServiceCase(req.principal,body,client);
      return { status:201, body:{ case:c } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get('/api/maintenance/cases/:id', async (req, reply) => {
    const { id } = req.params as { id:string };
    try {
      const c = await loadCaseForPrincipal(req.principal,id);
      if (!c) return reply.code(404).send({ error:'case_not_found' });
      const snapshot = await pool.query('select * from case_snapshots where case_id=$1',[id]);
      const { has_provider_relation:_,has_transport_relation:__,has_parts_relation:___,has_mobility_relation:____,...caseProjection } = c;
      return { case:caseProjection, customerSnapshot:snapshot.rows[0] ?? null };
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden') return reply.code(403).send({error:'forbidden'});
      throw error;
    }
  });

  app.get('/api/maintenance/cases/:id/timeline', async (req, reply) => {
    const { id } = req.params as { id:string };
    try {
      const c = await loadCaseForPrincipal(req.principal,id);
      if (!c) return reply.code(404).send({ error:'case_not_found' });
      return { timeline: await getCaseTimeline(id) };
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden') return reply.code(403).send({error:'forbidden'});
      throw error;
    }
  });

  app.post('/api/maintenance/cases/:id/transition', async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ toState:state, metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try {
      const c = await transitionCase(req.principal,id,body.toState,body.metadata ?? {});
      if (!c) return reply.code(404).send({ error:'case_not_found' });
      return { case:c };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'transition_failed';
      if (message === 'transition_forbidden') return reply.code(403).send({ error:message });
      if (message === 'invalid_case_transition') return reply.code(409).send({ error:message });
      throw e;
    }
  });

  app.put('/api/admin/cases/:id/customer-snapshot', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id:string };
    const body = z.object({ status:z.string().min(1), message:z.string().optional(), nextAction:z.string().optional(), etaAt:z.string().datetime().optional() }).parse(req.body);
    return { snapshot:await setCustomerSnapshot(id,body.status,body.message,body.nextAction,body.etaAt) };
  });

  app.post('/api/admin/cases/:id/deadlines', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ deadlineType:z.string().min(1), dueAt:z.string().datetime(), fallbackAction:z.string().optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    return reply.code(201).send({ deadline: await createDeadline(id,body.deadlineType,body.dueAt,body.fallbackAction,body.metadata ?? {}) });
  });

  app.post('/api/admin/operations/sweep-deadlines', { preHandler: requireRole('admin') }, async (req) => {
    const body = z.object({ limit:z.number().int().positive().max(500).default(100) }).parse(req.body ?? {});
    return { processed:await sweepExpiredDeadlines(req.principal,body.limit) };
  });

  app.post('/api/admin/cases/:id/exceptions', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ code:z.string().min(1), summary:z.string().min(1), severity:z.enum(['info','warning','critical']).default('warning'), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    return reply.code(201).send({ exception: await raiseException(id,body.code,body.summary,body.severity,body.metadata ?? {}) });
  });

  app.get('/api/admin/exceptions', { preHandler: requireRole('admin') }, async () => {
    const r = await pool.query(`select e.*,c.state as case_state,c.priority from case_exceptions e join service_cases c on c.id=e.case_id where e.state='open' order by case when e.severity='critical' then 0 when e.severity='warning' then 1 else 2 end,e.created_at asc limit 200`);
    return { exceptions:r.rows };
  });

  app.post('/api/admin/cases/:id/ledger', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ entryType:z.string().min(1), accountCode:z.string().min(1), counterpartyActorId:z.string().uuid().optional(), amount:z.number(), currency:z.string().length(3).default('USD'), state:z.string().default('pending'), externalReference:z.string().optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    return reply.code(201).send({ entry:await addLedgerEntry({ caseId:id,...body }) });
  });

  app.get('/api/admin/cases/:id/ledger', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id:string };
    const r = await pool.query('select * from ledger_entries where case_id=$1 order by occurred_at asc',[id]);
    return { ledger:r.rows };
  });
}
