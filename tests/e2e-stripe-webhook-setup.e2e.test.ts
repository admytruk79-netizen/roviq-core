import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// Core registers its own Stripe webhook (Stripe simulated) and then accepts events signed with the
// secret Stripe returned, which it stores and never exposes.

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };
const SECRET = 'whsec_registered_by_core_never_returned';

describe('Stripe webhook registered by Core', () => {
  let app: FastifyInstance;
  const saved = { key: process.env.STRIPE_SECRET_KEY, hook: process.env.STRIPE_WEBHOOK_SECRET };
  const endpoints: Array<{ id: string; url: string }> = [];
  const calls: string[] = [];

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_webhook_setup';
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await pool.query(`delete from integration_secrets where name = 'stripe_webhook_secret'`);
    app = await buildApp();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await pool.query(`delete from integration_secrets where name = 'stripe_webhook_secret'`);
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.hook !== undefined) process.env.STRIPE_WEBHOOK_SECRET = saved.hook;
    await app.close();
    await pool.end();
  });

  function stub() {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace('https://api.stripe.com/v1/', '')}`);
      if (method === 'GET') return new Response(JSON.stringify({ data: endpoints }), { status: 200 });
      if (method === 'DELETE') { const id = url.split('/').pop()!; endpoints.splice(endpoints.findIndex((e) => e.id === id), 1); return new Response('{}', { status: 200 }); }
      const body = new URLSearchParams(String(init?.body));
      const e = { id: `we_${++n}`, url: body.get('url')! };
      endpoints.push(e);
      return new Response(JSON.stringify({ ...e, secret: SECRET, livemode: false }), { status: 200 });
    }));
  }

  it('registers once, keeps the secret to itself, and replaces an endpoint whose secret it lacks', async () => {
    endpoints.push({ id: 'we_stale', url: 'https://roviq-core.onrender.com/api/payments/webhooks/stripe' });
    stub();
    const first = await app.inject({ method: 'POST', url: '/api/admin/integrations/stripe-webhook', headers: admin });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'replaced', url: 'https://roviq-core.onrender.com/api/payments/webhooks/stripe' });
    expect(first.json().events).toContain('checkout.session.completed');
    expect(first.body).not.toContain(SECRET);
    expect(calls).toContain('DELETE webhook_endpoints/we_stale');

    const again = await app.inject({ method: 'POST', url: '/api/admin/integrations/stripe-webhook', headers: admin });
    expect(again.json()).toMatchObject({ status: 'already_registered' });
    expect(endpoints).toHaveLength(1);

    const status = await app.inject({ method: 'GET', url: '/api/admin/integrations/status', headers: admin });
    expect(status.json().stripe).toMatchObject({ webhookSecret: true, webhookRegisteredByCore: true });
    expect(status.body).not.toContain(SECRET);
  });

  it('accepts events signed with the registered secret and rejects others', async () => {
    const body = '{"id":"evt_setup_check","type":"customer.created","data":{"object":{"id":"cus_1"}}}';
    const t = Math.floor(Date.now() / 1000);
    const sig = (secret: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
    const ok = await app.inject({ method: 'POST', url: '/api/payments/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': sig(SECRET) }, payload: body });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/payments/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': sig('whsec_wrong') }, payload: body });
    expect(bad.statusCode).toBe(401);
  });

  it('is admin only', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/admin/integrations/stripe-webhook' })).statusCode).toBe(401);
  });
});
