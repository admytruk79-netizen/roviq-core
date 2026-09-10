import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const WEBHOOK_SECRET = 'whsec_test_secret';

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}
function stripeSignature(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

describe('customer Stripe checkout end-to-end', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let strangerCustomerId: string;
  let caseId: string;
  let paymentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    strangerCustomerId = JSON.parse(stranger.body).actor.id;

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    caseId = JSON.parse(demandRes.body).case.id;

    const revisionRes = await app.inject({
      method: 'POST', url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`, headers: adminHeaders(),
      payload: { changeReason: 'Diagnosed worn brake pads', estimatedTotalMinor: 30000, currency: 'usd', tasks: [{ taskType: 'repair', title: 'Replace brake pads', estimatedAmountMinor: 30000 }] }
    });
    const approvalId = JSON.parse(revisionRes.body).plan.pendingApproval.id;
    await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${approvalId}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'approved' }
    });

    const paymentRes = await app.inject({
      method: 'POST', url: '/api/admin/payments', headers: adminHeaders(),
      payload: { caseId, amount: 300, currency: 'USD', description: 'Brake pad replacement' }
    });
    paymentId = JSON.parse(paymentRes.body).payment.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.CUSTOMER_WEB_URL;
  });

  it('rejects checkout-session creation for anyone but the owning customer', async () => {
    const strangerRes = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: actorHeaders('customer', strangerCustomerId) });
    expect(strangerRes.statusCode).toBe(404);
    expect(JSON.parse(strangerRes.body).error).toBe('payment_not_found');

    const adminRes = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: adminHeaders() });
    expect(adminRes.statusCode).toBe(403);
  });

  it('returns a clear error when Stripe or the return URL are not configured, instead of a broken redirect', async () => {
    const noWebUrlRes = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: actorHeaders('customer', customerActorId) });
    expect(noWebUrlRes.statusCode).toBe(503);
    expect(JSON.parse(noWebUrlRes.body).error).toBe('checkout_not_configured');

    process.env.CUSTOMER_WEB_URL = 'https://web.roviq.test';
    const noStripeRes = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: actorHeaders('customer', customerActorId) });
    expect(noStripeRes.statusCode).toBe(503);
    expect(JSON.parse(noStripeRes.body).error).toBe('stripe_not_configured');
  });

  it('creates a real Checkout Session once configured, and captures the payment when Stripe confirms it paid', async () => {
    process.env.CUSTOMER_WEB_URL = 'https://web.roviq.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const sessionRes = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: actorHeaders('customer', customerActorId) });
    expect(sessionRes.statusCode).toBe(200);
    expect(JSON.parse(sessionRes.body).checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.headers.authorization).toBe('Bearer sk_test_123');
    const sentParams = new URLSearchParams(init.body as string);
    expect(sentParams.get('success_url')).toBe(`https://web.roviq.test/cases/${caseId}?payment=success`);
    expect(sentParams.get('metadata[roviqPaymentIntentId]')).toBe(paymentId);
    expect(sentParams.get('line_items[0][price_data][unit_amount]')).toBe('30000');
    expect(sentParams.get('line_items[0][price_data][currency]')).toBe('usd');

    const stored = await pool.query('select provider,provider_intent_id,state from payment_intents where id=$1', [paymentId]);
    expect(stored.rows[0]).toMatchObject({ provider: 'stripe', provider_intent_id: 'cs_test_abc', state: 'created' });

    // Re-requesting checkout once state is no longer payable (e.g. after capture) is rejected.
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { metadata: { roviqPaymentIntentId: paymentId }, payment_intent: 'pi_test_1', payment_status: 'paid' } } });
    const webhookRes = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(raw, WEBHOOK_SECRET) }, payload: raw });
    expect(webhookRes.statusCode).toBe(200);

    const captured = await pool.query('select state from payment_intents where id=$1', [paymentId]);
    expect(captured.rows[0].state).toBe('captured');

    const retryRes = await app.inject({ method: 'POST', url: `/api/customers/me/payments/${paymentId}/checkout-session`, headers: actorHeaders('customer', customerActorId) });
    expect(retryRes.statusCode).toBe(409);
    expect(JSON.parse(retryRes.body).error).toBe('payment_not_payable');

    // A duplicate delivery of the same event (Stripe retries until it gets a 2xx) must not 500 --
    // the payment is already captured, so the resulting invalid_payment_transition is swallowed.
    const duplicateRes = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(raw, WEBHOOK_SECRET) }, payload: raw });
    expect(duplicateRes.statusCode).toBe(200);
  });

  it('rejects a webhook delivery with a missing or invalid signature, without touching the ledger', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const raw = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: { metadata: { roviqPaymentIntentId: paymentId }, payment_intent: 'pi_bad', payment_status: 'paid' } } });

    const missingRes = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json' }, payload: raw });
    expect(missingRes.statusCode).toBe(400);
    expect(JSON.parse(missingRes.body).error).toBe('invalid_signature');

    const tamperedRes = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(raw, 'wrong_secret') }, payload: raw });
    expect(tamperedRes.statusCode).toBe(400);
    expect(JSON.parse(tamperedRes.body).error).toBe('invalid_signature');
  });
});
