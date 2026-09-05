import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { createPaymentIntent, createPayout, refundPayment, updatePaymentState, updatePayoutState } from '../../services/payments.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';

export async function paymentRoutes(app: FastifyInstance) {
  app.post('/api/admin/payments', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ caseId:z.string().uuid(), amount:z.number().nonnegative(), currency:z.string().length(3).default('USD'), description:z.string().optional(), provider:z.string().default('manual'), providerIntentId:z.string().optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try { return reply.code(201).send({ payment:await createPaymentIntent(req.principal,body) }); }
    catch (e) {
      if (e instanceof Error && e.message==='case_not_found') return reply.code(404).send({ error:e.message });
      if (e instanceof Error && e.message==='quote_not_approved') return reply.code(409).send({ error:e.message });
      throw e;
    }
  });

  app.get('/api/maintenance/cases/:id/payments', async (req, reply) => {
    const { id } = req.params as { id:string };
    try {
      // Route through the shared access service (also used by cases.ts/mobility.ts) instead of a
      // second, narrower ad hoc check -- the previous version only recognized the customer or the
      // case's current owner, so a provider with a real relation to this case (an accepted offer,
      // an assigned dispatch, a parts order, a mobility allocation) was wrongly denied.
      const c = await loadCaseForPrincipal(req.principal,id);
      if (!c) return reply.code(404).send({ error:'case_not_found' });
    } catch (e) {
      if (e instanceof Error && e.message === 'forbidden') return reply.code(403).send({ error:'forbidden' });
      throw e;
    }
    const r = await pool.query('select id,case_id,amount,currency,state,description,created_at,updated_at,authorized_at,captured_at from payment_intents where case_id=$1 order by created_at desc',[id]);
    return { payments:r.rows };
  });

  app.post('/api/admin/payments/:id/state', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ state:z.enum(['requires_action','authorized','captured','cancelled','failed']), amount:z.number().positive().optional(), providerEventId:z.string().optional(), payload:z.record(z.unknown()).optional() }).parse(req.body);
    try { return { payment:await updatePaymentState(req.principal,id,body.state,{ amount:body.amount,providerEventId:body.providerEventId,payload:body.payload }) }; }
    catch (e) { const m=e instanceof Error?e.message:'payment_error'; if (m==='payment_not_found') return reply.code(404).send({ error:m }); if (m==='invalid_payment_transition') return reply.code(409).send({ error:m }); throw e; }
  });

  app.post('/api/admin/payments/:id/refunds', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ amount:z.number().positive(), providerEventId:z.string().optional(), payload:z.record(z.unknown()).optional() }).parse(req.body);
    try { return { payment:await refundPayment(req.principal,id,body.amount,body.providerEventId,body.payload ?? {}) }; }
    catch (e) { const m=e instanceof Error?e.message:'refund_error'; if (m==='payment_not_found') return reply.code(404).send({ error:m }); if (['refund_not_allowed','invalid_refund_amount'].includes(m)) return reply.code(409).send({ error:m }); throw e; }
  });

  app.post('/api/admin/payouts', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ caseId:z.string().uuid(), counterpartyActorId:z.string().uuid(), paymentIntentId:z.string().uuid().optional(), amount:z.number().nonnegative(), currency:z.string().length(3).default('USD'), provider:z.string().default('manual'), providerPayoutId:z.string().optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    return reply.code(201).send({ payout:await createPayout(req.principal,body) });
  });

  app.post('/api/admin/payouts/:id/state', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ state:z.enum(['approved','processing','paid','failed','cancelled']), externalReference:z.string().optional() }).parse(req.body);
    try { return { payout:await updatePayoutState(req.principal,id,body.state,body.externalReference) }; }
    catch (e) { const m=e instanceof Error?e.message:'payout_error'; if (m==='payout_not_found') return reply.code(404).send({ error:m }); if (m==='invalid_payout_transition') return reply.code(409).send({ error:m }); throw e; }
  });

  app.get('/api/partners/me/payouts', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query('select id,case_id,payment_intent_id,amount,currency,state,created_at,updated_at,paid_at from settlement_payouts where counterparty_actor_id=$1 order by created_at desc limit 200',[req.principal.actorId]);
    return { payouts:r.rows };
  });

  app.get('/api/admin/cases/:id/financials', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id:string };
    const [payments,payouts,ledger] = await Promise.all([
      pool.query('select * from payment_intents where case_id=$1 order by created_at asc',[id]),
      pool.query('select * from settlement_payouts where case_id=$1 order by created_at asc',[id]),
      pool.query('select * from ledger_entries where case_id=$1 order by occurred_at asc',[id])
    ]);
    return { payments:payments.rows,payouts:payouts.rows,ledger:ledger.rows };
  });
}
