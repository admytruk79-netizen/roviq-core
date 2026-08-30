import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const SKU = 'ROVIQ-DEGRADED-PART';

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('degraded cross-role case paths', () => {
  let app: FastifyInstance;
  let customerId: string;
  let diagnosticId: string;
  let strangerDiagnosticId: string;
  let partnerId: string;
  let towOneId: string;
  let towTwoId: string;
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
    strangerDiagnosticId = await make('diagnostic');
    partnerId = await make('shop', 'maintenance');
    towOneId = await make('tow');
    towTwoId = await make('tow');
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

  it('keeps the case coherent when tow declines and another provider takes over', async () => {
    const openedRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'urgent' }
    });
    expect(openedRes.statusCode).toBe(201);
    const opened = JSON.parse(openedRes.body);
    const caseId = opened.case.id as string;

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

    const firstAssign = await app.inject({
      method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: towOneId }
    });
    expect(firstAssign.statusCode).toBe(200);

    const decline = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', towOneId),
      payload: { status: 'declined', metadata: { reason: 'capacity_changed' } }
    });
    expect(decline.statusCode).toBe(200);
    expect(JSON.parse(decline.body).dispatch.status).toBe('declined');

    const afterDecline = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    const declinedCase = JSON.parse(afterDecline.body).case;
    expect(declinedCase.state).toBe('tow_pending');
    expect(declinedCase.current_owner_actor_id).toBeNull();

    const secondAssign = await app.inject({
      method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: towTwoId }
    });
    expect(secondAssign.statusCode).toBe(200);
    expect(JSON.parse(secondAssign.body).dispatch.provider_actor_id).toBe(towTwoId);

    const oldProviderGps = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/location`, headers: actorHeaders('tow', towOneId),
      payload: { lat: 45.521, lng: -122.671 }
    });
    expect(oldProviderGps.statusCode).toBe(403);

    const accept = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', towTwoId),
      payload: { status: 'accepted' }
    });
    expect(accept.statusCode).toBe(200);

    const inProgress = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    expect(JSON.parse(inProgress.body).case.state).toBe('tow_in_progress');

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const events = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['TRANSPORT_ASSIGNED','TRANSPORT_DECLINED','TRANSPORT_ACCEPTED','CASE_TOW_IN_PROGRESS']));
  });

  it('rejects findings from an unassigned diagnostic actor', async () => {
    const openedRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'check_engine', urgency: 'normal' }
    });
    const opened = JSON.parse(openedRes.body);
    const demandId = opened.demand.id as string;
    const caseId = opened.case.id as string;

    await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(),
      payload: { toState: 'diagnostic_pending' }
    });
    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,responded_at,rule_basis)
       values($1,$2,$3,1,'accepted',now(),'degraded_path_seed')`,
      [demandId, caseId, diagnosticId]
    );

    const strangerFinding = await app.inject({
      method: 'POST', url: `/api/diagnostics/demands/${demandId}/findings`, headers: actorHeaders('diagnostic', strangerDiagnosticId),
      payload: { summary: 'Unauthorized diagnostic attempt', drivability: 'unknown', disposition: 'diagnose_only' }
    });
    expect(strangerFinding.statusCode).toBe(403);
    expect(JSON.parse(strangerFinding.body).error).toBe('diagnostic_demand_not_assigned');

    const caseRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    expect(JSON.parse(caseRes.body).case.state).toBe('diagnostic_pending');
  });

  it('keeps a parts case pending when stock is unavailable and recovers after inventory arrives', async () => {
    const openedRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    const caseId = JSON.parse(openedRes.body).case.id as string;

    for (const toState of ['provider_selection','provider_pending','repair_in_progress']) {
      const res = await app.inject({
        method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState }
      });
      expect(res.statusCode).toBe(200);
    }

    const orderRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/parts-orders`, headers: adminHeaders(),
      payload: { items: [{ sku: SKU, quantity: 2 }] }
    });
    expect(orderRes.statusCode).toBe(201);
    const orderId = JSON.parse(orderRes.body).order.id as string;

    const assignRes = await app.inject({
      method: 'POST', url: `/api/admin/parts-orders/${orderId}/assign-supplier`, headers: adminHeaders(),
      payload: { supplierActorId: partsId }
    });
    expect(assignRes.statusCode).toBe(200);

    const unavailable = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/reserve`, headers: actorHeaders('parts', partsId)
    });
    expect(unavailable.statusCode).toBe(409);
    expect(JSON.parse(unavailable.body).error).toBe(`inventory_unavailable:${SKU}`);

    const pendingCase = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    expect(JSON.parse(pendingCase.body).case.state).toBe('parts_pending');

    const inventoryRes = await app.inject({
      method: 'PUT', url: '/api/parts/inventory', headers: actorHeaders('parts', partsId),
      payload: { sku: SKU, quantityOnHand: 3, unitPrice: 55 }
    });
    expect(inventoryRes.statusCode).toBe(200);

    const reserveRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/reserve`, headers: actorHeaders('parts', partsId)
    });
    expect(reserveRes.statusCode).toBe(200);

    for (const status of ['ordered','shipped','delivered']) {
      const res = await app.inject({
        method: 'POST', url: `/api/parts/orders/${orderId}/status`, headers: actorHeaders('parts', partsId), payload: { status }
      });
      expect(res.statusCode).toBe(200);
    }

    const recovered = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    expect(JSON.parse(recovered.body).case.state).toBe('repair_in_progress');
  });
});
