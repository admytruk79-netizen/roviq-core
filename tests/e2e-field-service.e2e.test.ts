import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('field service on-site assessment', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let towActorId: string;

  beforeAll(async () => {
    app = await buildApp();
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
    const tow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    towActorId = JSON.parse(tow.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('is registered, computes a deterministic action, and records/retrieves the decision', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId = JSON.parse(demandRes.body).case.id as string;

    const pending = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(),
      payload: { toState: 'tow_pending' }
    });
    expect(pending.statusCode).toBe(200);
    const dispatchRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', pickupLocation: { lat: 45.52, lng: -122.67 }, dropoffLocation: { lat: 45.54, lng: -122.65 } }
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;
    const assignRes = await app.inject({
      method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: towActorId }
    });
    expect(assignRes.statusCode).toBe(200);

    // Route must actually exist -- this used to 404 (fieldServiceRoutes was never registered in app.ts).
    const emptyHistory = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/field-service`, headers: adminHeaders() });
    expect(emptyHistory.statusCode).toBe(200);
    expect(JSON.parse(emptyHistory.body).decisions).toEqual([]);

    // No operator capability profile exists for towActorId, so operatorEligible() is false and
    // decide() deterministically lands on 'dispatch_field_technician' -- no authorization needed.
    const assessRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: actorHeaders('tow', towActorId),
      payload: {
        summary: 'Battery appears dead on arrival, jump start unsuccessful',
        repairClass: 'battery',
        drivability: 'non_drivable',
        confidence: 0.9,
        safety: {}
      }
    });
    expect(assessRes.statusCode).toBe(201);
    const decision = JSON.parse(assessRes.body).decision;
    // drivability:'non_drivable' takes safety priority over the capability check.
    expect(decision.action).toBe('tow_required');
    expect(decision.status).toBe('proposed');

    const historyRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/field-service`, headers: adminHeaders() });
    expect(historyRes.statusCode).toBe(200);
    const decisions = JSON.parse(historyRes.body).decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe(decision.id);

    const strangerTow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    const strangerTowActorId = JSON.parse(strangerTow.body).actor.id;
    const forbiddenAssess = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: actorHeaders('tow', strangerTowActorId),
      payload: { summary: 'unrelated tow trying to assess', safety: {} }
    });
    expect(forbiddenAssess.statusCode).toBe(403);
  });
});
