import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent, transitionCase } from './orchestration.js';
import { audit } from './audit.js';
import { setCustomerSnapshot } from './operations.js';

export async function createPaymentIntent(principal: Principal, input:{ caseId:string; amount:number; currency?:string; description?:string; provider?:string; providerIntentId?:string; metadata?:Record<string,unknown> }) {
  const c = await pool.query('select * from service_cases where id=$1',[input.caseId]);
  if (!c.rowCount) throw new Error('case_not_found');
  const customerActorId = c.rows[0].customer_actor_id ?? null;

  const plan = await pool.query('select id,current_revision from service_plans where case_id=$1',[input.caseId]);
  if (plan.rowCount) {
    const approval = await pool.query(
      `select state from case_approvals where case_id=$1 and service_plan_id=$2 and revision=$3 and approval_type='quote'
       order by created_at desc limit 1`,
      [input.caseId,plan.rows[0].id,plan.rows[0].current_revision]
    );
    if (!approval.rowCount || approval.rows[0].state !== 'approved') throw new Error('quote_not_approved');
  }

  const r = await pool.query(
    `insert into payment_intents(case_id,customer_actor_id,provider,provider_intent_id,amount,currency,description,metadata)
     values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [input.caseId,customerActorId,input.provider ?? 'manual',input.providerIntentId ?? null,input.amount,(input.currency ?? 'USD').toUpperCase(),input.description ?? null,JSON.stringify(input.metadata ?? {})]
  );
  const p = r.rows[0];
  await appendCaseEvent(input.caseId,'PAYMENT_INTENT_CREATED',principal,{ paymentIntentId:p.id, amount:p.amount, currency:p.currency });
  await audit(principal,'create_payment_intent','payment_intent',p.id,'case_payment',{ caseId:input.caseId, amount:input.amount });
  return p;
}

export async function updatePaymentState(principal: Principal, paymentIntentId:string, nextState:'requires_action'|'authorized'|'captured'|'cancelled'|'failed', input:{ amount?:number; providerEventId?:string; payload?:Record<string,unknown> }={}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from payment_intents where id=$1 for update',[paymentIntentId]);
    if (!current.rowCount) throw new Error('payment_not_found');
    const p = current.rows[0];
    const allowed:Record<string,string[]> = {
      created:['requires_action','authorized','captured','cancelled','failed'],
      requires_action:['authorized','captured','cancelled','failed'],
      authorized:['captured','cancelled','failed'],
      captured:[], cancelled:[], failed:[], partially_refunded:[], refunded:[]
    };
    if (!allowed[p.state]?.includes(nextState)) throw new Error('invalid_payment_transition');
    const stamp = nextState === 'authorized' ? ',authorized_at=now()' : nextState === 'captured' ? ',captured_at=now()' : nextState === 'cancelled' ? ',cancelled_at=now()' : '';
    const updated = await client.query(`update payment_intents set state=$1,updated_at=now() ${stamp} where id=$2 returning *`,[nextState,paymentIntentId]);
    await client.query(`insert into payment_events(payment_intent_id,event_type,amount,provider_event_id,payload) values($1,$2,$3,$4,$5)`,[paymentIntentId,nextState.toUpperCase(),input.amount ?? null,input.providerEventId ?? null,JSON.stringify(input.payload ?? {})]);
    if (nextState === 'captured') {
      await client.query(`insert into ledger_entries(case_id,payment_intent_id,entry_type,account_code,amount,currency,state,external_reference,metadata) values($1,$2,'payment_capture','customer_receivable',$3,$4,'posted',$5,$6)`,[p.case_id,paymentIntentId,input.amount ?? p.amount,p.currency,input.providerEventId ?? null,JSON.stringify({ provider:p.provider })]);
    }
    await client.query('commit');
    await appendCaseEvent(p.case_id,`PAYMENT_${nextState.toUpperCase()}`,principal,{ paymentIntentId, amount:input.amount ?? p.amount });
    if (nextState === 'captured') {
      await setCustomerSnapshot(p.case_id,'payment_received','Payment received. Finalizing your service journey.','Completion');
      const c = await pool.query('select state from service_cases where id=$1',[p.case_id]);
      if (c.rowCount && c.rows[0].state === 'payment_pending') await transitionCase(principal,p.case_id,'completed',{ paymentIntentId });
    }
    await audit(principal,'payment_state_change','payment_intent',paymentIntentId,`${p.state}->${nextState}`);
    return updated.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

export async function refundPayment(principal: Principal, paymentIntentId:string, amount:number, providerEventId?:string, payload:Record<string,unknown>={}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from payment_intents where id=$1 for update',[paymentIntentId]);
    if (!current.rowCount) throw new Error('payment_not_found');
    const p = current.rows[0];
    if (!['captured','partially_refunded'].includes(p.state)) throw new Error('refund_not_allowed');
    const refunded = await client.query(`select coalesce(sum(amount),0)::numeric as amount from payment_events where payment_intent_id=$1 and event_type='REFUND'`,[paymentIntentId]);
    const totalRefunded = Number(refunded.rows[0].amount) + amount;
    if (amount <= 0 || totalRefunded > Number(p.amount)) throw new Error('invalid_refund_amount');
    const nextState = totalRefunded === Number(p.amount) ? 'refunded' : 'partially_refunded';
    const updated = await client.query('update payment_intents set state=$1,updated_at=now() where id=$2 returning *',[nextState,paymentIntentId]);
    await client.query(`insert into payment_events(payment_intent_id,event_type,amount,provider_event_id,payload) values($1,'REFUND',$2,$3,$4)`,[paymentIntentId,amount,providerEventId ?? null,JSON.stringify(payload)]);
    await client.query(`insert into ledger_entries(case_id,payment_intent_id,entry_type,account_code,amount,currency,state,external_reference,metadata) values($1,$2,'refund','customer_refund',$3,$4,'posted',$5,$6)`,[p.case_id,paymentIntentId,-Math.abs(amount),p.currency,providerEventId ?? null,JSON.stringify({ provider:p.provider })]);
    await client.query('commit');
    await appendCaseEvent(p.case_id,'PAYMENT_REFUNDED',principal,{ paymentIntentId, amount, state:nextState });
    await audit(principal,'refund_payment','payment_intent',paymentIntentId,'refund',{ amount });
    return updated.rows[0];
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
}

export async function createPayout(principal: Principal, input:{ caseId:string; counterpartyActorId:string; paymentIntentId?:string; amount:number; currency?:string; provider?:string; providerPayoutId?:string; metadata?:Record<string,unknown> }) {
  const r = await pool.query(`insert into settlement_payouts(case_id,counterparty_actor_id,payment_intent_id,amount,currency,provider,provider_payout_id,metadata) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[input.caseId,input.counterpartyActorId,input.paymentIntentId ?? null,input.amount,(input.currency ?? 'USD').toUpperCase(),input.provider ?? 'manual',input.providerPayoutId ?? null,JSON.stringify(input.metadata ?? {})]);
  const payout = r.rows[0];
  await appendCaseEvent(input.caseId,'PAYOUT_CREATED',principal,{ payoutId:payout.id, counterpartyActorId:input.counterpartyActorId, amount:input.amount });
  await audit(principal,'create_payout','settlement_payout',payout.id,'provider_settlement',{ caseId:input.caseId });
  return payout;
}

export async function updatePayoutState(principal: Principal, payoutId:string, nextState:'approved'|'processing'|'paid'|'failed'|'cancelled', externalReference?:string) {
  const current = await pool.query('select * from settlement_payouts where id=$1',[payoutId]);
  if (!current.rowCount) throw new Error('payout_not_found');
  const p = current.rows[0];
  const allowed:Record<string,string[]> = { pending:['approved','cancelled'], approved:['processing','paid','cancelled'], processing:['paid','failed'], paid:[], failed:['processing','cancelled'], cancelled:[] };
  if (!allowed[p.state]?.includes(nextState)) throw new Error('invalid_payout_transition');
  const paidSql = nextState === 'paid' ? ',paid_at=now()' : '';
  const r = await pool.query(`update settlement_payouts set state=$1,updated_at=now() ${paidSql} where id=$2 returning *`,[nextState,payoutId]);
  if (nextState === 'paid') {
    await pool.query(`insert into ledger_entries(case_id,payment_intent_id,payout_id,entry_type,account_code,counterparty_actor_id,amount,currency,state,external_reference,metadata) values($1,$2,$3,'provider_payout','provider_payable',$4,$5,$6,'posted',$7,$8)`,[p.case_id,p.payment_intent_id ?? null,payoutId,p.counterparty_actor_id,-Math.abs(Number(p.amount)),p.currency,externalReference ?? p.provider_payout_id ?? null,JSON.stringify({ provider:p.provider })]);
  }
  await appendCaseEvent(p.case_id,`PAYOUT_${nextState.toUpperCase()}`,principal,{ payoutId, counterpartyActorId:p.counterparty_actor_id, amount:p.amount });
  await audit(principal,'payout_state_change','settlement_payout',payoutId,`${p.state}->${nextState}`);
  return r.rows[0];
}

// Real customer-initiated checkout for the amount an admin already recorded via createPaymentIntent
// (typically once a quote is approved -- see quotes.ts/service-plans.ts). Stripe Checkout Sessions
// are created via a plain fetch (matching the Twilio/Resend adapters in notifications.ts) rather
// than the stripe npm SDK, so there's no new dependency and the same "optional env var, dead-letters
// clearly if unset" shape as every other external provider in this codebase.
export async function createStripeCheckoutSession(payment:{ id:string; amount:string|number; currency:string; description:string|null }, urls:{ successUrl:string; cancelUrl:string }) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('stripe_not_configured');
  const unitAmount = Math.round(Number(payment.amount) * 100);
  const params = new URLSearchParams();
  params.set('mode','payment');
  params.set('success_url',urls.successUrl);
  params.set('cancel_url',urls.cancelUrl);
  params.set('client_reference_id',payment.id);
  params.set('metadata[roviqPaymentIntentId]',payment.id);
  params.set('line_items[0][quantity]','1');
  params.set('line_items[0][price_data][currency]',payment.currency.toLowerCase());
  params.set('line_items[0][price_data][unit_amount]',String(unitAmount));
  params.set('line_items[0][price_data][product_data][name]',payment.description ?? 'ROVIQ service payment');
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method:'POST',
    headers:{ authorization:`Bearer ${secretKey}`, 'content-type':'application/x-www-form-urlencoded' },
    body:params.toString()
  });
  const json = await response.json().catch(() => ({})) as Record<string,unknown>;
  if (!response.ok) {
    const message = typeof json.error === 'object' && json.error && 'message' in json.error ? String((json.error as Record<string,unknown>).message) : `stripe_http_${response.status}`;
    throw new Error(message);
  }
  return json as { id:string; url:string };
}

// Stripe signs each webhook delivery as "t=<unix ts>,v1=<hex hmac>" computed over
// "<ts>.<raw request body>" with the endpoint's signing secret (STRIPE_WEBHOOK_SECRET) -- verify
// against the exact raw bytes (see app.ts's rawBody capture), never a re-serialized JSON.parse
// round trip, or a genuine delivery with different key order/whitespace would be rejected.
export function verifyStripeWebhookSignature(rawBody:Buffer, signatureHeader:string, secret:string) {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=') as [string,string]));
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac('sha256',secret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
  const expectedBuf = Buffer.from(expected,'hex');
  const actualBuf = Buffer.from(parts.v1,'hex');
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf,actualBuf);
}
