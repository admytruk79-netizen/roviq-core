import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD!;

type SessionRole = 'customer' | 'partner' | 'diagnostic' | 'tow' | 'parts';
type SessionResponse = {
  accessToken: string;
  principal: { role: SessionRole; actorId: string };
};

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('portal access acceptance matrix', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    const body = JSON.parse(login.body) as {
      accessToken: string;
      principal: { role: string; actorId?: string | null };
    };
    expect(body.principal.role).toBe('admin');
    expect(body.accessToken).toBeTruthy();
    adminToken = body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('keeps Ops on direct admin access', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/cases',
      headers: bearer(adminToken)
    });
    expect(res.statusCode).toBe(200);
  });

  it('exchanges one valid admin login into every role portal session', async () => {
    const checks: Array<{ role: SessionRole; endpoint: string }> = [
      { role: 'customer', endpoint: '/api/customers/me/cases' },
      { role: 'partner', endpoint: '/api/partners/me/offers' },
      { role: 'diagnostic', endpoint: '/api/diagnostics/me/queue' },
      { role: 'tow', endpoint: '/api/transport/me/dispatches' },
      { role: 'parts', endpoint: '/api/partners/me/capacity' }
    ];

    for (const check of checks) {
      const exchange = await app.inject({
        method: 'POST',
        url: `/api/admin/testing/${check.role}-session`,
        headers: bearer(adminToken),
        payload: {}
      });
      expect(exchange.statusCode, `${check.role} session exchange`).toBe(200);

      const session = JSON.parse(exchange.body) as SessionResponse;
      expect(session.principal.role).toBe(check.role);
      expect(session.principal.actorId).toBeTruthy();
      expect(session.accessToken).toBeTruthy();

      const scoped = await app.inject({
        method: 'GET',
        url: check.endpoint,
        headers: bearer(session.accessToken)
      });
      expect(scoped.statusCode, `${check.role} scoped endpoint`).toBe(200);
    }
  });

  it('does not let a customer-scoped token enter a diagnostic workspace', async () => {
    const exchange = await app.inject({
      method: 'POST',
      url: '/api/admin/testing/customer-session',
      headers: bearer(adminToken),
      payload: {}
    });
    expect(exchange.statusCode).toBe(200);
    const session = JSON.parse(exchange.body) as SessionResponse;

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/diagnostics/me/queue',
      headers: bearer(session.accessToken)
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
