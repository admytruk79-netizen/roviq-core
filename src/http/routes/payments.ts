import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import type { Principal } from '../../types/principal.js';
import { requireRole } from '../middleware/principal.js';
import { createPaymentIntent, createPayout, refundPayment, updatePaymentState, updatePayoutState } from '../../services/payments.js';
import { getFinancialReconciliation } from '../../services/financial-reconciliation.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';
import { createStripePaymentIntent } from '../../services/stripe-payments.js';
import { createStripePartnerSettlement } from '../../services/stripe-settlements.js';

function errorMessage(error:unknown,fallback:string){
  return error instanceof Error?error.message:fallback;
}

async function requireAdminFinancialCaseAccess(principal:Principal,caseId:string,reply:FastifyReply){
  if(principal.role!=='admin'){
    reply.code(403).send({error:'forbidden'});
    return false;
  }
  if(!principal.actorId){
    const existing=await pool.query('select 1 from service_cases where id=$1',[caseId]);
    if(!existing.rowCount){reply.code(404).send({error:'case_not_found'});return false;}
    return true;
  }
  const actor=await pool.query(`select organization_id from actors where id=$1 and status='active'`,[principal.actorId]);
  if(!actor.rowCount){reply.code(403).send({error:'forbidden'});return false;}
  const organizationId=actor.rows[0].organization_id;
  const scoped=await pool.query(`
    select exists(
      select 1 from service_cases sc
      left join actors owner on owner.id=sc.current_owner_actor_id
      left join actors selected on selected.id=sc.selected_actor_id
      where sc.id=$1 and (
        owner.organization_id=$2 or selected.organization_id=$2 or
        exists(select 1 from matches_offers mo join actors a on a.id=mo.actor_id where mo.case_id=sc.id and mo.outcome='accepted' and a.organization_id=$2) or
        exists(select 1 from transport_dispatches td join actors a on a.id=td.provider_actor_id where td.case_id=sc.id and a.organization_id=$2) or
        exists(select 1 from parts_orders po join actors a on a.id=po.supplier_actor_id where po.case_id=sc.id and a.organization_id=$2) or
        exists(select 1 from mobility_allocations ma join actors a on a.id=ma.provider_actor_id where ma.case_id=sc.id and a.organization_id=$2)
      )
    ) as allowed`,[caseId,organizationId]);
  if(!scoped.rows[0]?.allowed){reply.code(403).send({error:'forbidden'});return false;}
  return true;
}

export async function paymentRoutes(app: FastifyInstance) {
  app.post('/api/admin/payments', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ caseId:z.string().uuid(), amount:z.number().nonnegative(), currency:z.string().length(3).default('USD'), description:z.string().optional(), provider:z.string().default('manual'), providerIntentId:z.string().optional(), clientRequestId:z.string().min(1).max(180).optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try { return reply.code(201).send({ payment:await createPaymentIntent(req.principal,body) }); }
    catch (e) {
      const message=errorMessage(e,'payment_error');
      if (message==='forbidden') return reply.code(403).send({ error:message });
      if (message==='case_not_found') return reply.code(404).send({ error:message });
      if (['currency_precision_unsupported','invalid_financial_amount'].includes(message)) return reply.code(422).send({ error:message });
      if (['quote_not_approved','provider_intent_conflict','payment_request_conflict'].includes(message)) return reply.code(409).send({ error:message });
      throw e;
    }
  });


  app.post('/api/admin/payments/stripe', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body=z.object({
      caseId:z.string().uuid(),
      amount:z.number().positive(),
      currency:z.string().length(3).default('USD'),
      description:z.string().max(500).optional(),
      idempotencyKey:z.string().min(8).max(180),
      metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    try{
      return reply.code(201).send(await createStripePaymentIntent(req.principal,body));
    }catch(error){
      const message=errorMessage(error,'stripe_payment_error');
      if(message==='forbidden') return reply.code(403).send({error:message});
      if(message==='case_not_found') return reply.code(404).send({error:message});
      if(['currency_precision_unsupported','invalid_financial_amount'].includes(message)) return reply.code(422).send({error:message});
      if(['quote_not_approved','payment_request_conflict','provider_intent_conflict','payment_request_terminal'].includes(message)) return reply.code(409).send({error:message});
      if(message==='stripe_not_configured') return reply.code(503).send({error:message});
      if(['stripe_request_failed','stripe_payment_create_failed'].includes(message)) return reply.code(502).send({error:message});
      throw error;
    }
  });

  app.get('/api/maintenance/cases/:id/payments', async (req, reply) => {
    const { id } = req.params as { id:string };
    if(req.principal.role==='admin'){
      if(!await requireAdminFinancialCaseAccess(req.principal,id,reply)) return;
    }else{
      try {
        const c = await loadCaseForPrincipal(req.principal,id);
        if (!c) return reply.code(404).send({ error:'case_not_found' });
      } catch (e) {
        if (e instanceof Error && e.message === 'forbidden') return reply.code(403).send({ error:'forbidden' });
        throw e;
      }
    }
    const r = await pool.query('select id,case_id,amount,currency,state,description,created_at,updated_at,authorized_at,captured_at from payment_intents where case_id=$1 order by created_at desc',[id]);
    return { payments:r.rows };
  });

  app.post('/api/admin/payments/:id/state', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ state:z.enum(['requires_action','authorized','captured','cancelled','failed']), amount:z.number().positive().optional(), providerEventId:z.string().optional(), payload:z.record(z.unknown()).optional() }).parse(req.body);
    try { return { payment:await updatePaymentState(req.principal,id,body.state,{ amount:body.amount,providerEventId:body.providerEventId,payload:body.payload }) }; }
    catch (e) {
      const m=errorMessage(e,'payment_error');
      if (m==='forbidden') return reply.code(403).send({ error:m });
      if (m==='payment_not_found'||m==='case_not_found') return reply.code(404).send({ error:m });
      if (m==='invalid_financial_amount') return reply.code(422).send({ error:m });
      if (['invalid_payment_transition','provider_event_conflict','capture_amount_mismatch'].includes(m)) return reply.code(409).send({ error:m });
      throw e;
    }
  });

  app.post('/api/admin/payments/:id/refunds', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ amount:z.number().positive(), providerEventId:z.string().optional(), payload:z.record(z.unknown()).optional() }).parse(req.body);
    try { return { payment:await refundPayment(req.principal,id,body.amount,body.providerEventId,body.payload ?? {}) }; }
    catch (e) {
      const m=errorMessage(e,'refund_error');
      if (m==='forbidden') return reply.code(403).send({ error:m });
      if (m==='payment_not_found') return reply.code(404).send({ error:m });
      if (m==='invalid_financial_amount') return reply.code(422).send({ error:m });
      if (['refund_not_allowed','invalid_refund_amount','refund_exceeds_available_balance','provider_event_conflict'].includes(m)) return reply.code(409).send({ error:m });
      throw e;
    }
  });


  app.post('/api/admin/payouts/stripe', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body=z.object({
      caseId:z.string().uuid(),
      counterpartyActorId:z.string().uuid(),
      paymentIntentId:z.string().uuid(),
      amount:z.number().positive(),
      currency:z.string().length(3).default('USD'),
      idempotencyKey:z.string().min(8).max(180),
      metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    try{
      return reply.code(201).send(await createStripePartnerSettlement(req.principal,body));
    }catch(error){
      const message=errorMessage(error,'stripe_settlement_error');
      if(message==='forbidden') return reply.code(403).send({error:message});
      if(['case_not_found','payment_not_found'].includes(message)) return reply.code(404).send({error:message});
      if(['currency_precision_unsupported','invalid_financial_amount'].includes(message)) return reply.code(422).send({error:message});
      if(['payout_counterparty_invalid','payout_payment_case_mismatch','payout_currency_mismatch','payout_exceeds_available_balance','payout_request_conflict','provider_payout_conflict','payout_request_terminal','stripe_connected_account_missing'].includes(message)) return reply.code(409).send({error:message});
      if(message==='stripe_not_configured') return reply.code(503).send({error:message});
      if(['stripe_settlement_request_failed','stripe_settlement_create_failed'].includes(message)) return reply.code(502).send({error:message});
      throw error;
    }
  });

  app.post('/api/admin/payouts', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ caseId:z.string().uuid(), counterpartyActorId:z.string().uuid(), paymentIntentId:z.string().uuid().optional(), amount:z.number().nonnegative(), currency:z.string().length(3).default('USD'), provider:z.string().default('manual'), providerPayoutId:z.string().optional(), clientRequestId:z.string().min(1).max(180).optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try{return reply.code(201).send({ payout:await createPayout(req.principal,body) });}
    catch(e){
      const m=errorMessage(e,'payout_error');
      if(m==='forbidden')return reply.code(403).send({error:m});
      if(['case_not_found','payment_not_found'].includes(m))return reply.code(404).send({error:m});
      if(['currency_precision_unsupported','invalid_financial_amount'].includes(m))return reply.code(422).send({error:m});
      if(['payout_counterparty_invalid','payout_payment_case_mismatch','payout_currency_mismatch','payout_exceeds_available_balance','provider_payout_conflict','payout_request_conflict'].includes(m))return reply.code(409).send({error:m});
      throw e;
    }
  });

  app.post('/api/admin/payouts/:id/state', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ state:z.enum(['approved','processing','paid','failed','cancelled']), externalReference:z.string().optional() }).parse(req.body);
    try { return { payout:await updatePayoutState(req.principal,id,body.state,body.externalReference) }; }
    catch (e) {
      const m=errorMessage(e,'payout_error');
      if (m==='forbidden') return reply.code(403).send({ error:m });
      if (['payout_not_found','payment_not_found'].includes(m)) return reply.code(404).send({ error:m });
      if (['invalid_payout_transition','provider_payout_conflict','payout_payment_not_funded','payout_provider_reference_required'].includes(m)) return reply.code(409).send({ error:m });
      throw e;
    }
  });

  app.get('/api/partners/me/payouts', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query('select id,case_id,payment_intent_id,amount,currency,state,created_at,updated_at,paid_at from settlement_payouts where counterparty_actor_id=$1 order by created_at desc limit 200',[req.principal.actorId]);
    return { payouts:r.rows };
  });

  app.get('/api/admin/cases/:id/financials', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    if(!await requireAdminFinancialCaseAccess(req.principal,id,reply)) return;
    const [payments,payouts,ledger,revenueAllocations,disputes] = await Promise.all([
      pool.query('select * from payment_intents where case_id=$1 order by created_at asc',[id]),
      pool.query('select * from settlement_payouts where case_id=$1 order by created_at asc',[id]),
      pool.query('select * from ledger_entries where case_id=$1 order by occurred_at asc',[id]),
      pool.query('select * from revenue_allocations where case_id=$1 order by occurred_at asc',[id]),
      pool.query(`select d.* from payment_disputes d join payment_intents p on p.id=d.payment_intent_id where p.case_id=$1 order by d.opened_at asc,d.id asc`,[id])
    ]);
    return { payments:payments.rows,payouts:payouts.rows,ledger:ledger.rows,revenueAllocations:revenueAllocations.rows,disputes:disputes.rows };
  });

  app.get('/api/admin/financial-reconciliation', { preHandler: requireRole('admin') }, async (req, reply) => {
    const query=z.object({limit:z.coerce.number().int().positive().max(500).default(200)}).parse(req.query??{});
    try{return await getFinancialReconciliation(req.principal,query.limit);}
    catch(error){
      const m=errorMessage(error,'financial_reconciliation_error');
      if(['financial_admin_only','financial_global_admin_only','forbidden'].includes(m)) return reply.code(403).send({error:m});
      throw error;
    }
  });
}
