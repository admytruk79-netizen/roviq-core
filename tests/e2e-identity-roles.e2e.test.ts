import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// One sign-in, several workspaces: a shop that also runs a tow truck logs in once and switches
// between its Shop and Tow tabs. Each tab's token is scoped to one role and its own actor, so the
// roles stay separated exactly as if they were two different logins.

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const PASSWORD = 'MultiRoleShopPassword123!';

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('multi-role sign-in', () => {
  let app: FastifyInstance;
  let shopActorId: string;
  let towActorId: string;
  let identityId: string;
  let email: string;
  let dispatchId: string;

  async function createActor(actorType: string) {
    const res = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType } });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).actor.id as string;
  }

  async function login() {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { accessToken: string; principal: { role: string }; roles: { role: string; actorId?: string; primary: boolean }[] };
  }

  async function switchRole(token: string, role: string) {
    return app.inject({ method: 'POST', url: '/api/auth/switch-role', headers: bearer(token), payload: { role } });
  }

  beforeAll(async () => {
    app = await buildApp();
    shopActorId = await createActor('partner');
    towActorId = await createActor('tow');
    email = `multi-role-${shopActorId}@roviq.test`;
    const identity = await app.inject({
      method: 'POST', url: '/api/admin/identities', headers: adminHeaders(),
      payload: { email, password: PASSWORD, role: 'partner', actorId: shopActorId }
    });
    expect(identity.statusCode).toBe(201);
    identityId = JSON.parse(identity.body).identity.id;

    // A tow dispatch on some customer's case, assigned to the business's tow actor.
    const customerActorId = await createActor('customer');
    const demand = await app.inject({
      method: 'POST', url: '/api/demands', headers: { 'x-roviq-role': 'customer', 'x-roviq-actor-id': customerActorId },
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal', location: { lat: 45.52, lng: -122.67 } }
    });
    const caseId = JSON.parse(demand.body).case.id;
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState: 'tow_pending' } });
    const dispatch = await app.inject({ method: 'POST', url: '/api/admin/transport', headers: adminHeaders(), payload: { caseId, transportType: 'tow' } });
    dispatchId = JSON.parse(dispatch.body).dispatch.id;
    const assign = await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(), payload: { providerActorId: towActorId } });
    expect(assign.statusCode).toBe(200);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('starts with only the primary role, and cannot switch to a role it was not granted', async () => {
    const session = await login();
    expect(session.principal.role).toBe('partner');
    expect(session.roles).toEqual([{ role: 'partner', actorId: shopActorId, primary: true }]);

    const denied = await switchRole(session.accessToken, 'tow');
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('role_not_granted');
    expect((await switchRole(session.accessToken, 'admin')).statusCode).toBe(403);
  });

  it('only an admin can grant roles, never the admin role, and never the primary role again', async () => {
    const session = await login();
    const selfGrant = await app.inject({
      method: 'PUT', url: `/api/admin/identities/${identityId}/roles/tow`, headers: bearer(session.accessToken), payload: { actorId: towActorId }
    });
    expect(selfGrant.statusCode).toBe(403);

    const adminGrant = await app.inject({
      method: 'PUT', url: `/api/admin/identities/${identityId}/roles/admin`, headers: adminHeaders(), payload: { actorId: towActorId }
    });
    expect(adminGrant.statusCode).toBe(400);

    const primaryAgain = await app.inject({
      method: 'PUT', url: `/api/admin/identities/${identityId}/roles/partner`, headers: adminHeaders(), payload: { actorId: towActorId }
    });
    expect(primaryAgain.statusCode).toBe(409);
  });

  it('switches between Shop and Tow tabs with each token limited to its own role and actor', async () => {
    const grant = await app.inject({
      method: 'PUT', url: `/api/admin/identities/${identityId}/roles/tow`, headers: adminHeaders(), payload: { actorId: towActorId }
    });
    expect(grant.statusCode).toBe(200);

    const session = await login();
    expect(session.roles.map((r) => r.role)).toEqual(['partner', 'tow']);
    const listed = await app.inject({ method: 'GET', url: '/api/auth/roles', headers: bearer(session.accessToken) });
    expect(JSON.parse(listed.body).active).toEqual({ role: 'partner', actorId: shopActorId });

    const switched = await switchRole(session.accessToken, 'tow');
    expect(switched.statusCode).toBe(200);
    const towToken = JSON.parse(switched.body).accessToken as string;
    expect(JSON.parse(switched.body).principal).toEqual({ role: 'tow', actorId: towActorId });

    // Tow tab sees the tow actor's dispatch; the Shop tab, same login, does not.
    const towQueue = await app.inject({ method: 'GET', url: '/api/transport/me/dispatches', headers: bearer(towToken) });
    expect(towQueue.statusCode).toBe(200);
    expect(JSON.parse(towQueue.body).dispatches.map((d: { id: string }) => d.id)).toContain(dispatchId);
    const shopQueue = await app.inject({ method: 'GET', url: '/api/transport/me/dispatches', headers: bearer(session.accessToken) });
    expect(JSON.parse(shopQueue.body).dispatches.map((d: { id: string }) => d.id)).not.toContain(dispatchId);

    // A role-specific area stays closed to the other tab, and neither token is an admin.
    expect((await app.inject({ method: 'GET', url: '/api/partners/me/controls', headers: bearer(session.accessToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/mobility/me/allocations', headers: bearer(towToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/transport', headers: bearer(towToken) })).statusCode).toBe(403);

    // Switching back works from the tow token too.
    const back = await switchRole(towToken, 'partner');
    expect(back.statusCode).toBe(200);
    expect(JSON.parse(back.body).principal.role).toBe('partner');
  });

  it('revoking a role cuts off its tokens immediately while the other roles keep working', async () => {
    const session = await login();
    const towToken = JSON.parse((await switchRole(session.accessToken, 'tow')).body).accessToken as string;

    const revoke = await app.inject({ method: 'DELETE', url: `/api/admin/identities/${identityId}/roles/tow`, headers: adminHeaders() });
    expect(revoke.statusCode).toBe(200);

    const rejected = await app.inject({ method: 'GET', url: '/api/transport/me/dispatches', headers: bearer(towToken) });
    expect(rejected.statusCode).toBe(401);
    expect((await switchRole(session.accessToken, 'tow')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/partners/me/controls', headers: bearer(session.accessToken) })).statusCode).toBe(200);
  });

  it('a forged token for a role on someone else\'s actor is rejected', async () => {
    const strangerTow = await createActor('tow');
    await app.inject({ method: 'PUT', url: `/api/admin/identities/${identityId}/roles/tow`, headers: adminHeaders(), payload: { actorId: towActorId } });
    const { issueAccessToken } = await import('../src/services/auth.js');
    const forged = await issueAccessToken(identityId, { role: 'tow', actorId: strangerTow });
    const res = await app.inject({ method: 'GET', url: '/api/transport/me/dispatches', headers: bearer(forged) });
    expect(res.statusCode).toBe(401);
  });

  it('deactivating the tow business rejects its tab without touching the shop tab', async () => {
    const session = await login();
    const towToken = JSON.parse((await switchRole(session.accessToken, 'tow')).body).accessToken as string;
    await pool.query(`update actors set status='inactive' where id=$1`, [towActorId]);
    try {
      expect((await app.inject({ method: 'GET', url: '/api/transport/me/dispatches', headers: bearer(towToken) })).statusCode).toBe(401);
      const roles = await app.inject({ method: 'GET', url: '/api/auth/roles', headers: bearer(session.accessToken) });
      expect(JSON.parse(roles.body).roles.map((r: { role: string }) => r.role)).toEqual(['partner']);
    } finally {
      await pool.query(`update actors set status='active' where id=$1`, [towActorId]);
    }
  });
});
