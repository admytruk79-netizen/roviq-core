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

describe('transport dispatch end-to-end lifecycle', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let towActorId: string;
  let strangerTowActorId: string;
  let incapableActorId: string;

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const tow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    towActorId = JSON.parse(tow.body).actor.id;

    const strangerTow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    strangerTowActorId = JSON.parse(strangerTow.body).actor.id;

    const incapable = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'shop', domain: 'maintenance' } });
    incapableActorId = JSON.parse(incapable.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('completes a full tow dispatch vertical slice with enforced access and transitions', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'urgent' }
    });
    expect(demandRes.statusCode).toBe(201);
    const { case: openedCase } = JSON.parse(demandRes.body);
    expect(openedCase.state).toBe('triage');
    const caseId = openedCase.id;

    const towPendingRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(),
      payload: { toState: 'tow_pending' }
    });
    expect(towPendingRes.statusCode).toBe(200);
    expect(JSON.parse(towPendingRes.body).case.state).toBe('tow_pending');

    const dispatchRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', pickupLocation: { lat: 1, lng: 1 }, dropoffLocation: { lat: 2, lng: 2 } }
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatch = JSON.parse(dispatchRes.body).dispatch;
    expect(dispatch.status).toBe('requested');
    const dispatchId = dispatch.id;

    // A dispatch already in tow_pending shouldn't be re-transitioned by dispatch creation.
    const caseStillPendingRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    expect(JSON.parse(caseStillPendingRes.body).case.state).toBe('tow_pending');

    // An unassigned dispatch (provider_actor_id is still null) must not be readable by just any
    // authenticated tow provider -- the previous check only compared provider_actor_id when it was
    // already set, so a still-unassigned dispatch's `&&` short-circuited and let anyone through.
    const unassignedViewRes = await app.inject({ method: 'GET', url: `/api/transport/${dispatchId}`, headers: actorHeaders('tow', strangerTowActorId) });
    expect(unassignedViewRes.statusCode).toBe(403);

    // A provider with no tow capability (no actor_type='tow', no partner_controls.tow_participation) must be rejected.
    const incapableAssignRes = await app.inject({
      method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: incapableActorId }
    });
    expect(incapableAssignRes.statusCode).toBe(409);
    expect(JSON.parse(incapableAssignRes.body).error).toBe('provider_not_transport_capable');

    const assignRes = await app.inject({
      method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: towActorId }
    });
    expect(assignRes.statusCode).toBe(200);
    expect(JSON.parse(assignRes.body).dispatch.status).toBe('assigned');

    // Skipping straight from 'assigned' to 'delivered' must be rejected as an invalid transition.
    const invalidSkipRes = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', towActorId),
      payload: { status: 'delivered' }
    });
    expect(invalidSkipRes.statusCode).toBe(409);
    expect(JSON.parse(invalidSkipRes.body).error).toBe('invalid_dispatch_transition');

    // An unassigned tow provider cannot see or act on someone else's dispatch.
    const strangerViewRes = await app.inject({ method: 'GET', url: `/api/transport/${dispatchId}`, headers: actorHeaders('tow', strangerTowActorId) });
    expect(strangerViewRes.statusCode).toBe(403);
    const strangerStatusRes = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', strangerTowActorId),
      payload: { status: 'accepted' }
    });
    expect(strangerStatusRes.statusCode).toBe(403);
    expect(JSON.parse(strangerStatusRes.body).error).toBe('dispatch_forbidden');

    const acceptRes = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', towActorId),
      payload: { status: 'accepted' }
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(JSON.parse(acceptRes.body).dispatch.status).toBe('accepted');

    // Accepting the dispatch auto-transitions the case from tow_pending to tow_in_progress.
    const caseInProgressRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: actorHeaders('tow', towActorId) });
    expect(caseInProgressRes.statusCode).toBe(200);
    expect(JSON.parse(caseInProgressRes.body).case.state).toBe('tow_in_progress');

    for (const status of ['en_route', 'arrived', 'vehicle_loaded', 'in_transit', 'delivered']) {
      const res = await app.inject({
        method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', towActorId),
        payload: { status }
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).dispatch.status).toBe(status);
    }

    // Delivery resolves the transport-assignment deadline created when the dispatch was first requested.
    const deadlines = await pool.query(
      `select state from workflow_deadlines where case_id=$1 and deadline_type like 'transport_%'`, [caseId]
    );
    expect(deadlines.rows.length).toBeGreaterThan(0);
    expect(deadlines.rows.every((row) => row.state === 'resolved')).toBe(true);

    // This transport-only scenario has no repair provider pre-assigned. After delivery the
    // tow provider returns the case to provider selection; a case with an already-related
    // repair partner may use the explicit tow -> repair handoff covered by the cross-role test.
    const handoffRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: actorHeaders('tow', towActorId),
      payload: { toState: 'provider_selection' }
    });
    expect(handoffRes.statusCode).toBe(200);
    expect(JSON.parse(handoffRes.body).case.state).toBe('provider_selection');

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const timelineEvents = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(timelineEvents).toEqual(expect.arrayContaining([
      'CASE_CREATED', 'SERVICE_PLAN_CREATED', 'CASE_TRIAGE', 'CASE_TOW_PENDING', 'TRANSPORT_REQUESTED',
      'TRANSPORT_ASSIGNED', 'CASE_TOW_IN_PROGRESS', 'TRANSPORT_ACCEPTED', 'TRANSPORT_EN_ROUTE',
      'TRANSPORT_ARRIVED', 'TRANSPORT_VEHICLE_LOADED', 'TRANSPORT_IN_TRANSIT', 'TRANSPORT_DELIVERED',
      'CASE_PROVIDER_SELECTION'
    ]));

    // Isolation: a customer with no relation to this case must not be able to view it.
    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const strangerId = JSON.parse(stranger.body).actor.id;
    const strangerCase = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: actorHeaders('customer', strangerId) });
    expect(strangerCase.statusCode).toBe(403);
  });

  it('completes a decline with only one pool connection available (pool-exhaustion regression)', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'urgent' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState: 'tow_pending' } });
    const dispatchRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', pickupLocation: { lat: 1, lng: 1 }, dropoffLocation: { lat: 2, lng: 2 } }
    });
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;
    await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(), payload: { providerActorId: towActorId } });

    // Pool max is 10 (src/db/pool.ts). Hold 9 raw connections so the decline's own transaction
    // takes the last one. Before the fix, updateTransportStatus's declined branch called
    // appendCaseEvent -- a second pool.query -- while still holding that transaction's connection;
    // with zero spare connections left, the second acquisition would block until
    // connectionTimeoutMillis and the whole decline would time out and roll back.
    const heldClients = await Promise.all(Array.from({ length: 9 }, () => pool.connect()));
    try {
      const declineRes = await app.inject({
        method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', towActorId),
        payload: { status: 'declined' }
      });
      expect(declineRes.statusCode).toBe(200);
      expect(JSON.parse(declineRes.body).dispatch.status).toBe('declined');
    } finally {
      heldClients.forEach((c) => c.release());
    }
  }, 15000);

  it('does not clear case ownership when a superseded dispatch declines after a newer one took over', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'urgent' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState: 'tow_pending' } });

    const secondTow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    const secondTowActorId = JSON.parse(secondTow.body).actor.id as string;

    // Two separate dispatches on the same case -- e.g. a first tow provider assigned, then
    // reassigned to a second while the first dispatch record is still around, unresolved.
    const dispatchARes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', pickupLocation: { lat: 1, lng: 1 }, dropoffLocation: { lat: 2, lng: 2 } }
    });
    const dispatchAId = JSON.parse(dispatchARes.body).dispatch.id as string;
    await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchAId}/assign`, headers: adminHeaders(), payload: { providerActorId: towActorId } });

    const dispatchBRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', pickupLocation: { lat: 1, lng: 1 }, dropoffLocation: { lat: 2, lng: 2 } }
    });
    const dispatchBId = JSON.parse(dispatchBRes.body).dispatch.id as string;
    await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchBId}/assign`, headers: adminHeaders(), payload: { providerActorId: secondTowActorId } });

    const ownerAfterB = await pool.query('select current_owner_actor_id from service_cases where id=$1', [caseId]);
    expect(ownerAfterB.rows[0].current_owner_actor_id).toBe(secondTowActorId);

    // Dispatch A's provider declines -- this must not strip dispatch B's provider's ownership.
    const declineRes = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchAId}/status`, headers: actorHeaders('tow', towActorId),
      payload: { status: 'declined' }
    });
    expect(declineRes.statusCode).toBe(200);

    const ownerAfterDecline = await pool.query('select current_owner_actor_id from service_cases where id=$1', [caseId]);
    expect(ownerAfterDecline.rows[0].current_owner_actor_id).toBe(secondTowActorId);
  });
});
