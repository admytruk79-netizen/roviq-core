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

    const diagnosticOffer = await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,rule_basis)
       values($1,$2,$3,1,'offered','cross_role_lifecycle_seed') returning id`,
      [demandId, caseId, diagnosticId]
    );
    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,responded_at,rule_basis)
       values($1,$2,$3,2,'accepted',now(),'cross_role_lifecycle_seed')`,
      [demandId, caseId, partnerId]
    );

    const acceptDiagnostic = await app.inject({
      method:'POST', url:`/api/offers/${diagnosticOffer.rows[0].id}/respond`,
      headers:actorHeaders('diagnostic',diagnosticId), payload:{outcome:'accepted'}
    });
    expect(acceptDiagnostic.statusCode).toBe(200);
    expect(JSON.parse(acceptDiagnostic.body).case.state).toBe('diagnostic_in_progress');
    const diagnosticOwner = await pool.query('select current_owner_role,current_owner_actor_id from service_cases where id=$1',[caseId]);
    expect(diagnosticOwner.rows[0]).toMatchObject({current_owner_role:'diagnostic',current_owner_actor_id:diagnosticId});

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
    const assignedTowOwner = await pool.query('select current_owner_role,current_owner_actor_id from service_cases where id=$1',[caseId]);
    expect(assignedTowOwner.rows[0]).toMatchObject({current_owner_role:'tow',current_owner_actor_id:towId});

    const gpsRes = await app.inject({
      method: 'POST', url: `/api/transport/${dispatchId}/location`, headers: actorHeaders('tow', towId),
      payload: { lat: 45.524, lng: -122.675, accuracy: 4, heading: 92, speed: 8.5 }
    });
    expect(gpsRes.statusCode).toBe(200);

    const acceptedTow = await app.inject({
      method:'POST', url:`/api/transport/${dispatchId}/status`, headers:actorHeaders('tow',towId),
      payload:{status:'accepted'}
    });
    expect(acceptedTow.statusCode).toBe(200);
    const acceptedTowOwner = await pool.query('select state,current_owner_role,current_owner_actor_id from service_cases where id=$1',[caseId]);
    expect(acceptedTowOwner.rows[0]).toMatchObject({state:'tow_in_progress',current_owner_role:'tow',current_owner_actor_id:towId});

    for (const status of ['en_route','arrived','vehicle_loaded','in_transit','delivered']) {
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

    // Shop OS scheduling for the bay/technician doing this repair -- this is the same
    // authoritative case, so its appointment lifecycle must interleave cleanly with the
    // canonical case state machine rather than being an island only exercised in isolation.
    const shopOrg = await pool.query(
      `insert into organizations(organization_type,display_name) values('shop','Cross-Role Lifecycle Shop') returning id`
    );
    const shopOrgId = shopOrg.rows[0].id as string;
    // A dedicated, capability-less actor to manage the bay and call Shop OS as -- deliberately
    // NOT reusing or mutating partnerId, which already carries a global 'repair' capability
    // grant. Giving partnerId an organization_id/capacity would make it an eligible candidate
    // in any OTHER test file's unrelated, unscoped routeMaintenanceDemand query (which matches
    // purely on capability, with no domain/test isolation), corrupting that file's ranking
    // assertions. This actor has no capabilities at all, so it's invisible to that query.
    const shopBayManager = await pool.query(
      `insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,
      [shopOrgId]
    );
    const shopBayManagerId = shopBayManager.rows[0].id as string;
    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,rule_basis) values($1,$2,$3,1,'accepted','shop_os_lifecycle_tenant_link')`,
      [demandId, caseId, shopBayManagerId]
    );
    const shopConnection = await pool.query(
      `insert into partner_system_connections(organization_id,mode,provider_key,display_name,connection_status)
       values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,
      [shopOrgId]
    );
    const shopResource = await pool.query(
      `insert into service_resources(organization_id,resource_type,display_name,active,source_connection_id)
       values($1,'bay','Bay 1',true,$2) returning id`,
      [shopOrgId, shopConnection.rows[0].id]
    );
    const shopResourceId = shopResource.rows[0].id as string;
    await pool.query(
      `insert into capacity_windows(organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
        capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state)
       values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '4 hours','available',1,1,'roviq_native','current')`,
      [shopOrgId, shopConnection.rows[0].id, shopResourceId]
    );
    const appointmentStart = new Date(Date.now() + 10 * 60_000).toISOString();
    const appointmentEnd = new Date(Date.now() + 130 * 60_000).toISOString();

    const appointmentRes = await app.inject({
      method: 'POST', url: '/api/shop-os/appointments', headers: actorHeaders('partner', shopBayManagerId),
      payload: { serviceCaseId: caseId, resourceId: shopResourceId, startsAt: appointmentStart, endsAt: appointmentEnd, serviceCategory: 'repair', status: 'confirmed' }
    });
    expect(appointmentRes.statusCode).toBe(201);
    const appointment = JSON.parse(appointmentRes.body).appointment;
    expect(appointment.service_case_id).toBe(caseId);
    expect(appointment.appointment_status).toBe('confirmed');

    const startWorkRes = await app.inject({
      method: 'PATCH', url: `/api/shop-os/appointments/${appointment.id}`, headers: actorHeaders('partner', shopBayManagerId),
      payload: { action: 'start' }
    });
    expect(startWorkRes.statusCode).toBe(200);
    expect(JSON.parse(startWorkRes.body).appointment.appointment_status).toBe('in_progress');

    // The case itself is untouched by appointment scheduling -- Shop OS tracks the bay's
    // workflow, not the case's, so it must still read repair_in_progress throughout.
    const duringAppointment = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: actorHeaders('partner', partnerId) });
    expect(JSON.parse(duringAppointment.body).case.state).toBe('repair_in_progress');

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

    const completeWorkRes = await app.inject({
      method: 'PATCH', url: `/api/shop-os/appointments/${appointment.id}`, headers: actorHeaders('partner', shopBayManagerId),
      payload: { action: 'complete' }
    });
    expect(completeWorkRes.statusCode).toBe(200);
    expect(JSON.parse(completeWorkRes.body).appointment.appointment_status).toBe('completed');

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
