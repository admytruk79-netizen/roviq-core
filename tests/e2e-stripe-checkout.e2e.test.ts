import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// Customer card payment through Stripe Checkout, with Stripe's API simulated: the customer opens
// Checkout for their own payment, comes back, and Core records the payment only once Stripe says
// the session is paid. The webhook path records the same payment once, whichever arrives first.

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
const as = (role: string, actorId: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actorId });

type StripeCall = { url: string; method: string; body: URLSearchParams; headers: Record<string, string> };

function stripeStub(sessions: Record<string, Record<string, unknown>>, calls: StripeCall[]) {
  let n = 0;
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: new URLSearchParams(String(init?.body ?? '')), headers: (init?.headers ?? {}) as Record<string, string> });
    if (method === 'POST' && url.endsWith('/v1/checkout/sessions')) {
      const id = `cs_test_${++n}_${Date.now()}`;
      const body = new URLSearchParams(String(init?.body ?? ''));
      sessions[id] = {
        id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid', payment_intent: null,
        amount_total: Number(body.get('line_items[0][price_data][unit_amount]')), currency: body.get('line_items[0][price_data][currency]'),
        expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
        metadata: { roviq_payment_intent_id: body.get('metadata[roviq_payment_intent_id]'), roviq_case_id: body.get('metadata[roviq_case_id]') }
      };
      return new Response(JSON.stringify(sessions[id]), { status: 200 });
    }
    const m = url.match(/\/v1\/checkout\/sessions\/([^/?]+)$/);
    if (method === 'GET' && m && sessions[decodeURIComponent(m[1])]) return new Response(JSON.stringify(sessions[decodeURIComponent(m[1])]), { status: 200 });
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 404 });
  });
}

function sign(body: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}`;
}

describe('customer card payment through Stripe Checkout', () => {
  let app: FastifyInstance;
  let customerId: string;
  let strangerId: string;
  const saved = { secret: process.env.STRIPE_SECRET_KEY, webhook: process.env.STRIPE_WEBHOOK_SECRET };
  const sessions: Record<string, Record<string, unknown>> = {};
  let calls: StripeCall[] = [];

  async function newCaseWithPayment(amount: number) {
    const domain = await pool.query(`select id from domains where code='maintenance' limit 1`);
    const c = await pool.query(
      `insert into service_cases(domain_id,case_type,state,customer_actor_id) values($1,'maintenance','payment_pending',$2) returning id`,
      [domain.rows[0].id, customerId]
    );
    const created = await app.inject({ method: 'POST', url: '/api/admin/payments', headers: admin, payload: { caseId: c.rows[0].id, amount, currency: 'USD', description: 'Brake repair', provider: 'manual' } });
    expect(created.statusCode).toBe(201);
    return { caseId: c.rows[0].id as string, paymentId: created.json().payment.id as string };
  }

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_checkout';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_checkout_test';
    app = await buildApp();
    customerId = (await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType: 'customer' } })).json().actor.id;
    strangerId = (await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType: 'customer' } })).json().actor.id;
  });

  afterEach(() => { vi.unstubAllGlobals(); calls = []; });

  afterAll(async () => {
    if (saved.secret === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.secret;
    if (saved.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = saved.webhook;
    await app.close();
    await pool.end();
  });

  it('opens Checkout for exactly the requested amount and sends the customer back to the case', async () => {
    const { caseId, paymentId } = await newCaseWithPayment(125.5);
    vi.stubGlobal('fetch', stripeStub(sessions, calls));
    const res = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: { ...as('customer', customerId), origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.body.get('mode')).toBe('payment');
    expect(create.body.get('line_items[0][price_data][unit_amount]')).toBe('12550');
    expect(create.body.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(create.body.get('metadata[roviq_payment_intent_id]')).toBe(paymentId);
    expect(create.body.get('payment_intent_data[metadata][roviq_payment_intent_id]')).toBe(paymentId);
    // An unknown Origin never becomes the return address.
    expect(create.body.get('success_url')).toBe(`https://roviq-core-customer.pages.dev/cases/${caseId}?payment=success&payment_id=${paymentId}&session_id={CHECKOUT_SESSION_ID}`);
    expect(create.headers['idempotency-key']).toBe(`roviq-checkout:${paymentId}:1`);

    // Tapping Pay now again reuses the open session instead of creating another.
    const again = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: as('customer', customerId) });
    expect(again.json().checkoutUrl).toBe(res.json().checkoutUrl);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('inside the ROVIQ app, returns to the app’s customer tab at the case', async () => {
    const { caseId, paymentId } = await newCaseWithPayment(20);
    vi.stubGlobal('fetch', stripeStub(sessions, calls));
    const res = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: { ...as('customer', customerId), origin: 'https://roviq-service.pages.dev' }, payload: { surface: 'app' } });
    expect(res.statusCode).toBe(200);
    const successUrl = calls.find((c) => c.method === 'POST')!.body.get('success_url')!;
    expect(successUrl.startsWith('https://roviq-service.pages.dev/?open=customer&at=')).toBe(true);
    // What the app receives once Stripe fills in the session id.
    const returned = new URL(successUrl.replace('{CHECKOUT_SESSION_ID}', 'cs_test_abc'));
    expect(returned.searchParams.get('at')).toBe(`/cases/${caseId}?payment=success&payment_id=${paymentId}&session_id=cs_test_abc`);

    // Paying from the standalone customer app instead opens a new session that returns there.
    const standalone = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: as('customer', customerId), payload: { surface: 'customer' } });
    expect(standalone.json().checkoutUrl).not.toBe(res.json().checkoutUrl);
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body.get('success_url')).toContain(`https://roviq-core-customer.pages.dev/cases/${caseId}?payment=success`);
  });

  it('is only for the customer who owes the payment', async () => {
    const { paymentId } = await newCaseWithPayment(40);
    vi.stubGlobal('fetch', stripeStub(sessions, calls));
    expect((await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: as('customer', strangerId) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: admin })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session` })).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('records the payment and completes the case only once Stripe reports the session paid', async () => {
    const { caseId, paymentId } = await newCaseWithPayment(80);
    vi.stubGlobal('fetch', stripeStub(sessions, calls));
    await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: as('customer', customerId) });
    const sessionId = Object.keys(sessions).find((id) => (sessions[id].metadata as Record<string, string>).roviq_payment_intent_id === paymentId)!;
    const confirm = () => app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session/confirm`, headers: as('customer', customerId), payload: { sessionId } });

    // Returned without paying: nothing is recorded.
    const unpaid = await confirm();
    expect(unpaid.statusCode).toBe(200);
    expect(unpaid.json()).toMatchObject({ paid: false, state: 'created' });

    Object.assign(sessions[sessionId], { status: 'complete', payment_status: 'paid', payment_intent: `pi_${sessionId}` });
    const paid = await confirm();
    expect(paid.json()).toMatchObject({ paid: true, state: 'captured' });
    expect((await confirm()).json()).toMatchObject({ paid: true, state: 'captured' });

    const p = await pool.query('select state, provider, provider_intent_id from payment_intents where id=$1', [paymentId]);
    expect(p.rows[0]).toMatchObject({ state: 'captured', provider: 'stripe', provider_intent_id: `pi_${sessionId}` });
    const ledger = await pool.query(`select count(*)::int as n from ledger_entries where payment_intent_id=$1 and entry_type='payment_capture'`, [paymentId]);
    expect(ledger.rows[0].n).toBe(1);
    const c = await pool.query('select state from service_cases where id=$1', [caseId]);
    expect(c.rows[0].state).toBe('completed');
  });

  it('refuses a session that belongs to another payment or does not match the amount', async () => {
    const first = await newCaseWithPayment(30);
    const second = await newCaseWithPayment(31);
    vi.stubGlobal('fetch', stripeStub(sessions, calls));
    await app.inject({ method: 'POST', url: `/api/customers/me/payments/${second.paymentId}/checkout-session`, headers: as('customer', customerId) });
    const otherSession = Object.keys(sessions).find((id) => (sessions[id].metadata as Record<string, string>).roviq_payment_intent_id === second.paymentId)!;
    Object.assign(sessions[otherSession], { status: 'complete', payment_status: 'paid' });
    const wrong = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${first.paymentId}/checkout-session/confirm`, headers: as('customer', customerId), payload: { sessionId: otherSession } });
    expect(wrong.statusCode).toBe(422);

    Object.assign(sessions[otherSession], { amount_total: 100 });
    const short = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${second.paymentId}/checkout-session/confirm`, headers: as('customer', customerId), payload: { sessionId: otherSession } });
    expect(short.statusCode).toBe(409);
    const states = await pool.query('select state from payment_intents where id = any($1::uuid[])', [[first.paymentId, second.paymentId]]);
    expect(states.rows.map((r) => r.state)).toEqual(['created', 'created']);
  });

  it('records a Checkout payment from Stripe’s webhook once, even with the payment event first', async () => {
    const { caseId, paymentId } = await newCaseWithPayment(55);
    vi.stubGlobal('fetch', stripeStub(sessions, calls));
    await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: as('customer', customerId) });
    const sessionId = Object.keys(sessions).find((id) => (sessions[id].metadata as Record<string, string>).roviq_payment_intent_id === paymentId)!;
    const piId = `pi_hook_${Date.now()}`;

    const deliver = async (event: Record<string, unknown>) => {
      const body = JSON.stringify(event);
      return app.inject({ method: 'POST', url: '/api/payments/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) }, payload: body });
    };
    // Stripe's payment event can arrive before Core knows the PaymentIntent's ID.
    const succeeded = await deliver({ id: `evt_pi_${Date.now()}`, type: 'payment_intent.succeeded', data: { object: { id: piId, amount: 5500, amount_received: 5500, currency: 'usd', metadata: { roviq_payment_intent_id: paymentId, roviq_case_id: caseId } } } });
    expect(succeeded.statusCode).toBe(200);
    const completed = await deliver({ id: `evt_cs_${Date.now()}`, type: 'checkout.session.completed', data: { object: { ...sessions[sessionId], status: 'complete', payment_status: 'paid', payment_intent: piId } } });
    expect(completed.statusCode).toBe(200);

    const p = await pool.query('select state, provider_intent_id from payment_intents where id=$1', [paymentId]);
    expect(p.rows[0]).toMatchObject({ state: 'captured', provider_intent_id: piId });
    const ledger = await pool.query(`select count(*)::int as n from ledger_entries where payment_intent_id=$1 and entry_type='payment_capture'`, [paymentId]);
    expect(ledger.rows[0].n).toBe(1);
  });
});
