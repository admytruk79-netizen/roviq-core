import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };
const password = 'Independent-business-123!';
const fixture = (role = 'partner') => {
  const requestId = randomUUID();
  return { requestId, role, businessName: `Independent ${requestId}`, operatorName: 'Pilot operator',
    email: `${requestId}@example.test`, password,
    location: { name: 'Main workshop', address: '123 Test Street', city: 'Portland', region: 'OR', countryCode: 'US' } };
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
describe('independent business onboarding', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); await pool.end(); });
  const create = (payload: Record<string, unknown>, headers = admin) => app.inject({ method: 'POST', url: '/api/admin/business-onboarding', headers, payload });
  const login = (email: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  it.each([
    ['partner', '/api/shop-os/repair-orders'], ['diagnostic', '/api/diagnostics/me/queue'],
    ['tow', '/api/transport/me/dispatches'], ['parts', '/api/parts/me/orders'], ['fleet', '/api/mobility/me/allocations']
  ])('provisions a real %s login with only its own workspace', async (role, endpoint) => {
    const input = fixture(role);
    const result = await create(input);
    expect(result.statusCode).toBe(201);
    const business = result.json().business;
    expect(business).toMatchObject({ actorId: input.requestId, role, readiness: 'configuration_required', replayed: false });
    expect(result.body).not.toContain(password);
    const session = await login(input.email);
    expect(session.statusCode).toBe(200);
    const body = session.json();
    expect(body.principal).toEqual({ role, actorId: business.actorId });
    expect(body.roles).toEqual([{ role, actorId: business.actorId, primary: true }]);
    expect((await app.inject({ method: 'GET', url: endpoint, headers: bearer(body.accessToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/switch-role', headers: bearer(body.accessToken), payload: { role: 'admin' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/business-onboarding', headers: bearer(body.accessToken) })).statusCode).toBe(403);
    expect((await create(fixture(), bearer(body.accessToken) as typeof admin)).statusCode).toBe(403);
    const record = await pool.query(`select a.organization_id,a.location_id,l.organization_id as location_organization,
      (select count(*)::int from capacity_snapshots where actor_id=a.id) as capacity,
      (select count(*)::int from actor_capabilities where actor_id=a.id) as capabilities,
      (select routing_enabled from partner_controls where actor_id=a.id) as routing_enabled
      from actors a join locations l on l.id=a.location_id where a.id=$1`, [business.actorId]);
    expect(record.rows[0]).toMatchObject({ organization_id: business.organizationId, location_id: business.locationId,
      location_organization: business.organizationId, capacity: 0, capabilities: 0 });
    if (role === 'partner') expect(record.rows[0].routing_enabled).toBe(false);
  });

  it('serializes simultaneous retries without duplicate businesses, identities or audit events', async () => {
    const input = fixture();
    const results = await Promise.all([create(input), create(input)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 201]);
    expect(results[0].json().business.actorId).toBe(results[1].json().business.actorId);
    const counts = await pool.query(`select
      (select count(*)::int from organizations where display_name=$1) as organizations,
      (select count(*)::int from principal_identities where actor_id=$2) as identities,
      (select count(*)::int from audit_log where action='onboard_business' and object_id=$2::text) as audits`, [input.businessName, input.requestId]);
    expect(counts.rows[0]).toEqual({ organizations: 1, identities: 1, audits: 1 });
    expect((await create({ ...input, email: input.email.toUpperCase() })).statusCode).toBe(200);
    expect((await create({ ...input, password: 'Different-password-123!' })).statusCode).toBe(409);
    expect((await create({ ...input, businessName: 'Changed request' })).statusCode).toBe(409);
    const audit = await pool.query(`select metadata from audit_log where action='onboard_business' and object_id=$1`, [input.requestId]);
    expect(JSON.stringify(audit.rows)).not.toContain(password);
  });

  it('rolls back every business record when the email is already registered', async () => {
    const first = fixture();
    expect((await create(first)).statusCode).toBe(201);
    const second = { ...fixture(), email: first.email };
    expect((await create(second)).statusCode).toBe(409);
    const result = await pool.query(`select
      (select count(*)::int from actors where id=$1) as actors,
      (select count(*)::int from organizations where display_name=$2) as organizations`, [second.requestId, second.businessName]);
    expect(result.rows[0]).toEqual({ actors: 0, organizations: 0 });
  });

  it('keeps two onboarded shops isolated and rejects a token after actor suspension', async () => {
    const first = fixture(); const second = fixture();
    const a = (await create(first)).json().business;
    const b = (await create(second)).json().business;
    const token = (await login(first.email)).json().accessToken;
    expect((await app.inject({ method: 'GET', url: `/api/shop-os/repair-orders?organizationId=${b.organizationId}`, headers: bearer(token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/shop-os/repair-orders?locationId=${b.locationId}`, headers: bearer(token) })).statusCode).toBe(403);
    await pool.query(`update actors set status='suspended' where id=$1`, [a.actorId]);
    expect((await app.inject({ method: 'GET', url: '/api/shop-os/repair-orders', headers: bearer(token) })).statusCode).toBe(401);
  });

  it('does not provision admin/customer roles, weak credentials or invalid countries', async () => {
    for (const change of [{ role: 'admin' }, { role: 'customer' }, { password: 'short' }, { location: { ...fixture().location, countryCode: '12' } }]) {
      expect((await create({ ...fixture(), ...change })).statusCode).toBe(400);
    }
  });
});
