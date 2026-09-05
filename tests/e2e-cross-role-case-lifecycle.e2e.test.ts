import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const SKU = 'ROVIQ-LIFECYCLE-PART';

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('cross-role maintenance case lifecycle', () => {
  let app: FastifyInstance;
  let customerId: string;
  let diagnosticId: string;
  let partnerId: string;
  let towId: string;
  let partsId: string;

  beforeAll(async () => {
    app = await buildApp();
    const make = async (actorType: string, domain?: string) => {
      const res = await app.inject({
        method: 'POST', url: '/api/admin/actors', headers: adminHeaders(),
        payload: { actorType, ...(domain ? { domain } : {}) }
      });
      expect(res.statusCode).toBe(201);
      return JSON.parse(res.body).actor.id as string;
    };
    customerId = await make('customer');
    diagnosticId = await make('diagnostic');
    partnerId = await make('shop', 'maintenance');
    towId = await make('tow');
    partsId = await make('parts');
    await pool.query(
      `insert into actor_capabilities(actor_id, capability_id)
       select $1,id from capabilities where capability_code='repair'
       on conflict do nothing`,
      [partnerId]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('moves one authoritative case across diagnostic, tow, partner and parts roles to completion', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'urgent' }
    });
    expect(demandRes.statusCode).toBe(201);
    const opened = JSON.parse(demandRes.body);
    const demandId = opened.demand.id as string;
    const caseId = opened.case.id as string;
    expect(opened.case.state).toBe('triage');

    const diagnosticPending = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(),
      payload: { toState: 'diagnostic_pending' }
    });
    expect(diagnosticPending.statusCode).toBe(200);

    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,responded_at,rule_basis)
       values($1,$2,$3,1,'accepted',now(),'cross_role_lifecycle_seed')`,
      [demandId, caseId, diagnosticId]
    );
    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,responded_at,rule_basis)
       values($1,$2,$3,2,'accepted',now(),'cross_role_lifecycle_seed')`,
      [demandId, caseId, partnerId]
    );

    const diagnosticQueue = await app.inject({
      method: 'GET', url: '/api/diagnostics/me/queue', headers: actorHeaders('diagnostic', diagnosticId)
    });
    expect(diagnosticQueue.statusCode).toBe(200);
    expect(JSON.parse(diagnosticQueue.body).queue.some((q: { case_id: string }) => q.case_id === caseId)).toBe(true);

    const findingRes = await app.inject({
      method: 'POST', url: `/api/diagnostics/demands/${demandId}/findings`, headers: actorHeaders('diagnostic', diagnosticId),
      payload: {
        summary: 'Vehicle will not start and requires transport to the assigned repair operation.',
        drivability: 'non_drivable', disposition: 'route_to_tow', confidence: 0.98,
        details: { batteryVoltage: 10.9 }
      }
    });
    expect(findingRes.statusCode).toBe(201);
    expect(JSON.parse(findingRes.body).case.state).toBe('tow_pending');

    // Case-scoped read of the same finding, gated by the shared case access service rather than
    // the demand-scoped route's own matches_offers check -- the diagnostic who recorded it and the
    // case's customer can both read it, an actor with no relation to the case yet cannot.
    const findingsRes = await app.inject({
      method: 'GET', url: `/api/maintenance/cases/${caseId}/diagnostic-findings`, headers: actorHeaders('diagnostic', diagnosticId)
    });
    expect(findingsRes.statusCode).toBe(200);
    const findings = JSON.parse(findingsRes.body).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].disposition).toBe('route_to_tow');
    expect(findings[0].drivability).toBe('non_drivable');

    const customerFindingsRes = await app.inject({
      method: 'GET', url: `/api/maintenance/cases/${caseId}/diagnostic-findings`, headers: actorHeaders('customer', customerId)
    });
    expect(customerFindingsRes.statusCode).toBe(200);

    const unrelatedFindingsRes = await app.inject({
      method: 'GET', url: `/api/maintenance/cases/${caseId}/diagnostic-findings`, headers: actorHeaders('tow', towId)
    });
    expect(unrelatedFindingsRes.statusCode).toBe(403);

    const dispatchRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: {
        caseId, transportType: 'tow',
        pickupLocation: { lat: 45.5231, lng: -122.6765 },
        dropoffLocation: { lat: 45.535, lng: -122.65 }
      }
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;

    const assignTow = await app.inject({
      method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: towId }
    });
    expect(assignTow.statusCode).toBe(200);

    const gpsRes = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/location`, headers: actorHeaders('tow', towId),
      payload: { lat: 45.524, lng: -122.675, accuracy: 4, heading: 92, speed: 8.5 }
    });
    expect(gpsRes.statusCode).toBe(200);

    for (const status of ['accepted','en_route','arrived','vehicle_loaded','in_transit','delivered']) {
      const res = await app.inject({
        method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', towId),
        payload: { status }
      });
      expect(res.statusCode).toBe(200);
    }

    const handoffRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: actorHeaders('partner', partnerId),
      payload: { toState: 'repair_in_progress', metadata: { source: 'tow_handoff' } }
    });
    expect(handoffRes.statusCode).toBe(200);
    expect(JSON.parse(handoffRes.body).case.state).toBe('repair_in_progress');

    const orderRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/parts-orders`, headers: actorHeaders('partner', partnerId),
      payload: { items: [{ sku: SKU, quantity: 1, description: 'Lifecycle verification component' }] }
    });
    expect(orderRes.statusCode).toBe(201);
    const orderId = JSON.parse(orderRes.body).order.id as string;

    const inventoryRes = await app.inject({
      method: 'PUT', url: '/api/parts/inventory', headers: actorHeaders('parts', partsId),
      payload: { sku: SKU, quantityOnHand: 2, unitPrice: 40 }
    });
    expect(inventoryRes.statusCode).toBe(200);

    const supplierRes = await app.inject({
      method: 'POST', url: `/api/admin/parts-orders/${orderId}/assign-supplier`, headers: adminHeaders(),
      payload: { supplierActorId: partsId }
    });
    expect(supplierRes.statusCode).toBe(200);

    const reserveRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/reserve`, headers: actorHeaders('parts', partsId)
    });
    expect(reserveRes.statusCode).toBe(200);

    for (const status of ['ordered','shipped','delivered']) {
      const res = await app.inject({
        method: 'POST', url: `/api/parts/orders/${orderId}/status`, headers: actorHeaders('parts', partsId),
        payload: { status }
      });
      expect(res.statusCode).toBe(200);
    }

    const resumed = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: actorHeaders('partner', partnerId) });
    expect(resumed.statusCode).toBe(200);
    expect(JSON.parse(resumed.body).case.state).toBe('repair_in_progress');

    const revisionRes = await app.inject({
      method: 'POST', url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`, headers: adminHeaders(),
      payload: {
        changeReason: 'Repair confirmed after diagnostic, tow and parts fulfilment', estimatedTotalMinor: 15900, currency: 'usd',
        tasks: [{ taskType: 'repair', title: 'Complete verified repair', estimatedAmountMinor: 15900 }]
      }
    });
    expect(revisionRes.statusCode).toBe(201);
    const approvalId = JSON.parse(revisionRes.body).plan.pendingApproval.id as string;

    const paymentPending = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: actorHeaders('partner', partnerId),
      payload: { toState: 'payment_pending' }
    });
    expect(paymentPending.statusCode).toBe(200);

    const approveRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${approvalId}/decision`, headers: actorHeaders('customer', customerId),
      payload: { decision: 'approved' }
    });
    expect(approveRes.statusCode).toBe(200);

    const paymentRes = await app.inject({
      method: 'POST', url: '/api/admin/payments', headers: adminHeaders(),
      payload: { caseId, amount: 159, currency: 'USD', description: 'Verified service lifecycle' }
    });
    expect(paymentRes.statusCode).toBe(201);
    const paymentId = JSON.parse(paymentRes.body).payment.id as string;

    const captureRes = await app.inject({
      method: 'POST', url: `/api/admin/payments/${paymentId}/state`, headers: adminHeaders(),
      payload: { state: 'captured' }
    });
    expect(captureRes.statusCode).toBe(200);

    const finalCase = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: actorHeaders('customer', customerId) });
    expect(finalCase.statusCode).toBe(200);
    expect(JSON.parse(finalCase.body).case.state).toBe('completed');

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const events = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(events).toEqual(expect.arrayContaining([
      'CASE_CREATED','CASE_DIAGNOSTIC_PENDING','CASE_TOW_PENDING','TRANSPORT_REQUESTED','TRANSPORT_ASSIGNED',
      'TRANSPORT_ACCEPTED','TRANSPORT_DELIVERED','CASE_REPAIR_IN_PROGRESS','PARTS_ORDER_CREATED','CASE_PARTS_PENDING',
      'PARTS_SUPPLIER_ASSIGNED','PARTS_RESERVED','PARTS_ORDERED','PARTS_SHIPPED','PARTS_DELIVERED',
      'CASE_PAYMENT_PENDING','CASE_APPROVAL_DECIDED','PAYMENT_INTENT_CREATED','CASE_COMPLETED'
    ]));

    const spatialRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/spatial`, headers: actorHeaders('customer', customerId) });
    expect(spatialRes.statusCode).toBe(200);
    const spatial = JSON.parse(spatialRes.body).spatial;
    expect(spatial.transport_location).toBeTruthy();
    expect(spatial.diagnostic_location).toBeUndefined();
    expect(spatial.parts_origin).toBeUndefined();
  });
});
