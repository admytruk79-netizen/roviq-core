import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const SKU = 'ROVIQ-SYSTEM-ACCEPTANCE-PART';

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('ROVIQ system acceptance journey', () => {
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
        method: 'POST',
        url: '/api/admin/actors',
        headers: adminHeaders(),
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
    await app.close();
    await pool.end();
  });

  it('moves one case through customer, diagnostic, tow, partner, parts and payment to completion', async () => {
    const demandRes = await app.inject({
      method: 'POST',
      url: '/api/demands',
      headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'urgent' }
    });
    expect(demandRes.statusCode).toBe(201);
    const opened = JSON.parse(demandRes.body);
    const demandId = opened.demand.id as string;
    const caseId = opened.case.id as string;
    expect(opened.case.state).toBe('triage');

    const diagnosticPending = await app.inject({
      method: 'POST',
      url: `/api/maintenance/cases/${caseId}/transition`,
      headers: adminHeaders(),
      payload: { toState: 'diagnostic_pending' }
    });
    expect(diagnosticPending.statusCode).toBe(200);

    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,responded_at,rule_basis)
       values($1,$2,$3,1,'accepted',now(),'system_acceptance_seed')`,
      [demandId, caseId, diagnosticId]
    );
    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,responded_at,rule_basis)
       values($1,$2,$3,2,'accepted',now(),'system_acceptance_seed')`,
      [demandId, caseId, partnerId]
    );

    const diagnosticStart = await app.inject({
      method: 'POST',
      url: `/api/maintenance/cases/${caseId}/transition`,
      headers: actorHeaders('diagnostic', diagnosticId),
      payload: { toState: 'diagnostic_in_progress' }
    });
    expect(diagnosticStart.statusCode).toBe(200);

    const findingRes = await app.inject({
      method: 'POST',
      url: `/api/diagnostics/demands/${demandId}/findings`,
      headers: actorHeaders('diagnostic', diagnosticId),
      payload: {
        summary: 'Vehicle will not start and requires transport to the repair provider.',
        drivability: 'non_drivable',
        disposition: 'route_to_tow',
        confidence: 0.98,
        details: { batteryVoltage: 10.9 }
      }
    });
    expect(findingRes.statusCode).toBe(201);
    expect(JSON.parse(findingRes.body).case.state).toBe('tow_pending');

    const dispatchRes = await app.inject({
      method: 'POST',
      url: '/api/admin/transport',
      headers: adminHeaders(),
      payload: {
        caseId,
        transportType: 'tow',
        pickupLocation: { lat: 45.5231, lng: -122.6765 },
        dropoffLocation: { lat: 45.535, lng: -122.65 }
      }
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;

    const assignTow = await app.inject({
      method: 'POST',
      url: `/api/admin/transport/${dispatchId}/assign`,
      headers: adminHeaders(),
      payload: { providerActorId: towId }
    });
    expect(assignTow.statusCode).toBe(200);

    for (const status of ['accepted', 'en_route', 'arrived', 'vehicle_loaded', 'in_transit', 'delivered']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/transport/${dispatchId}/status`,
        headers: actorHeaders('tow', towId),
        payload: { status }
      });
      expect(res.statusCode, `tow status ${status}`).toBe(200);
    }

    const repairStart = await app.inject({
      method: 'POST',
      url: `/api/maintenance/cases/${caseId}/transition`,
      headers: actorHeaders('partner', partnerId),
      payload: { toState: 'repair_in_progress', metadata: { source: 'tow_handoff' } }
    });
    expect(repairStart.statusCode).toBe(200);
    expect(JSON.parse(repairStart.body).case.state).toBe('repair_in_progress');

    const orderRes = await app.inject({
      method: 'POST',
      url: `/api/maintenance/cases/${caseId}/parts-orders`,
      headers: actorHeaders('partner', partnerId),
      payload: { items: [{ sku: SKU, quantity: 1, description: 'System acceptance component' }] }
    });
    expect(orderRes.statusCode).toBe(201);
    const orderId = JSON.parse(orderRes.body).order.id as string;

    const inventoryRes = await app.inject({
      method: 'PUT',
      url: '/api/parts/inventory',
      headers: actorHeaders('parts', partsId),
      payload: { sku: SKU, quantityOnHand: 2, unitPrice: 40 }
    });
    expect(inventoryRes.statusCode).toBe(200);

    const supplierRes = await app.inject({
      method: 'POST',
      url: `/api/admin/parts-orders/${orderId}/assign-supplier`,
      headers: adminHeaders(),
      payload: { supplierActorId: partsId }
    });
    expect(supplierRes.statusCode).toBe(200);

    const reserveRes = await app.inject({
      method: 'POST',
      url: `/api/parts/orders/${orderId}/reserve`,
      headers: actorHeaders('parts', partsId)
    });
    expect(reserveRes.statusCode).toBe(200);

    for (const status of ['ordered', 'shipped', 'delivered']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/parts/orders/${orderId}/status`,
        headers: actorHeaders('parts', partsId),
        payload: { status }
      });
      expect(res.statusCode, `parts status ${status}`).toBe(200);
    }

    const revisionRes = await app.inject({
      method: 'POST',
      url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`,
      headers: adminHeaders(),
      payload: {
        changeReason: 'Repair confirmed after diagnosis, transport and parts fulfilment',
        estimatedTotalMinor: 15900,
        currency: 'usd',
        tasks: [{ taskType: 'repair', title: 'Complete verified repair', estimatedAmountMinor: 15900 }]
      }
    });
    expect(revisionRes.statusCode).toBe(201);
    const approvalId = JSON.parse(revisionRes.body).plan.pendingApproval.id as string;

    const paymentPending = await app.inject({
      method: 'POST',
      url: `/api/maintenance/cases/${caseId}/transition`,
      headers: actorHeaders('partner', partnerId),
      payload: { toState: 'payment_pending' }
    });
    expect(paymentPending.statusCode).toBe(200);

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/maintenance/cases/${caseId}/approvals/${approvalId}/decision`,
      headers: actorHeaders('customer', customerId),
      payload: { decision: 'approved' }
    });
    expect(approveRes.statusCode).toBe(200);

    const paymentRes = await app.inject({
      method: 'POST',
      url: '/api/admin/payments',
      headers: adminHeaders(),
      payload: { caseId, amount: 159, currency: 'USD', description: 'System acceptance service' }
    });
    expect(paymentRes.statusCode).toBe(201);
    const paymentId = JSON.parse(paymentRes.body).payment.id as string;

    const captureRes = await app.inject({
      method: 'POST',
      url: `/api/admin/payments/${paymentId}/state`,
      headers: adminHeaders(),
      payload: { state: 'captured' }
    });
    expect(captureRes.statusCode).toBe(200);

    const finalCase = await app.inject({
      method: 'GET',
      url: `/api/maintenance/cases/${caseId}`,
      headers: actorHeaders('customer', customerId)
    });
    expect(finalCase.statusCode).toBe(200);
    expect(JSON.parse(finalCase.body).case.state).toBe('completed');

    const timelineRes = await app.inject({
      method: 'GET',
      url: `/api/maintenance/cases/${caseId}/timeline`,
      headers: adminHeaders()
    });
    expect(timelineRes.statusCode).toBe(200);
    const events = JSON.parse(timelineRes.body).timeline.map((event: { event_type: string }) => event.event_type);
    expect(events).toEqual(expect.arrayContaining([
      'CASE_CREATED',
      'CASE_DIAGNOSTIC_PENDING',
      'CASE_DIAGNOSTIC_IN_PROGRESS',
      'CASE_TOW_PENDING',
      'TRANSPORT_REQUESTED',
      'TRANSPORT_ASSIGNED',
      'TRANSPORT_DELIVERED',
      'CASE_REPAIR_IN_PROGRESS',
      'PARTS_ORDER_CREATED',
      'PARTS_DELIVERED',
      'CASE_PAYMENT_PENDING',
      'CASE_APPROVAL_DECIDED',
      'PAYMENT_INTENT_CREATED',
      'CASE_COMPLETED'
    ]));
  });
});
