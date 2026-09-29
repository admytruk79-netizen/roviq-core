import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const SECRET = 'sk_test_THIS_VALUE_MUST_NEVER_BE_RETURNED';

describe('production integration status', () => {
  let app: FastifyInstance;
  const saved = { secret: process.env.STRIPE_SECRET_KEY, webhook: process.env.STRIPE_WEBHOOK_SECRET };

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    app = await buildApp();
  });

  afterAll(async () => {
    if (saved.secret === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.secret;
    if (saved.webhook !== undefined) process.env.STRIPE_WEBHOOK_SECRET = saved.webhook;
    await pool.end();
  });

  it('tells an admin what is configured, with Stripe mode, and never the values', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/integrations/status', headers: { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.stripe).toEqual({ secretKey: true, webhookSecret: false, publishableKey: expect.any(Boolean), mode: 'test' });
    expect(typeof body.sms.twilio).toBe('boolean');
    expect(Array.isArray(body.notificationChannels)).toBe(true);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('THIS_VALUE');
  });

  it('is closed to everyone but admins', async () => {
    const actor = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY }, payload: { actorType: 'partner' } });
    const partnerId = JSON.parse(actor.body).actor.id;
    expect((await app.inject({ method: 'GET', url: '/api/admin/integrations/status', headers: { 'x-roviq-role': 'partner', 'x-roviq-actor-id': partnerId } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/integrations/status' })).statusCode).toBe(401);
  });
});
