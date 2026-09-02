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

describe('spatial authorization and role projection', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let towActorId: string;
  let strangerTowActorId: string;

  beforeAll(async () => {
    app = await buildApp();
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
    const tow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    towActorId = JSON.parse(tow.body).actor.id;
    const strangerTow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    strangerTowActorId = JSON.parse(strangerTow.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('keeps exact spatial fields role-scoped and rejects unassigned GPS writes', async () => {
    const demandRes = await app.inject({
      method: 'POST',
      url: '/api/demands',
      headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'urgent' }
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId = JSON.parse(demandRes.body).case.id as string;

    const towPending = await app.inject({
      method: 'POST',
      url: `/api/maintenance/cases/${caseId}/transition`,
      headers: adminHeaders(),
      payload: { toState: 'tow_pending' }
    });
    expect(towPending.statusCode).toBe(200);

    const seedSpatial = await app.inject({
      method: 'PUT',
      url: `/api/admin/cases/${caseId}/spatial`,
      headers: adminHeaders(),
      payload: {
        origin: { lat: 45.52, lng: -122.67, label: 'Breakdown' },
        currentVehicle: { lat: 45.52, lng: -122.67 },
        destination: { lat: 45.54, lng: -122.64, label: 'Service destination' },
        diagnosticLocation: { lat: 45.51, lng: -122.68, internal: 'diagnostic-only' },
        providerLocation: { lat: 45.54, lng: -122.64, internal: 'provider-only' },
        partsOrigin: { lat: 45.58, lng: -122.60, internal: 'parts-only' },
        routeContext: {
          distanceMiles: 4.8,
          etaMinutes: 13,
          candidates: {
            [towActorId]: { distanceMiles: 4.8, etaMinutes: 13 },
            [strangerTowActorId]: { distanceMiles: 22.1, etaMinutes: 47 }
          }
        },
        source: 'e2e_spatial_authorization'
      }
    });
    expect(seedSpatial.statusCode).toBe(200);

    const dispatchRes = await app.inject({
      method: 'POST',
      url: '/api/admin/transport',
      headers: adminHeaders(),
      payload: {
        caseId,
        transportType: 'tow',
        pickupLocation: { lat: 45.52, lng: -122.67 },
        dropoffLocation: { lat: 45.54, lng: -122.64 }
      }
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;

    const assignRes = await app.inject({
      method: 'POST',
      url: `/api/admin/transport/${dispatchId}/assign`,
      headers: adminHeaders(),
      payload: { providerActorId: towActorId }
    });
    expect(assignRes.statusCode).toBe(200);

    const forbiddenLocation = await app.inject({
      method: 'POST',
      url: `/api/transport/${dispatchId}/location`,
      headers: actorHeaders('tow', strangerTowActorId),
      payload: { lat: 45.521, lng: -122.671, heading: 90, speed: 8 }
    });
    expect(forbiddenLocation.statusCode).toBe(403);
    expect(JSON.parse(forbiddenLocation.body).error).toBe('dispatch_forbidden');

    const liveLocation = await app.inject({
      method: 'POST',
      url: `/api/transport/${dispatchId}/location`,
      headers: actorHeaders('tow', towActorId),
      payload: { lat: 45.521, lng: -122.671, heading: 90, speed: 8 }
    });
    expect(liveLocation.statusCode).toBe(200);
    expect(JSON.parse(liveLocation.body).transportLocation.dispatchId).toBe(dispatchId);

    const towSpatialRes = await app.inject({
      method: 'GET',
      url: `/api/maintenance/cases/${caseId}/spatial`,
      headers: actorHeaders('tow', towActorId)
    });
    expect(towSpatialRes.statusCode).toBe(200);
    const towSpatial = JSON.parse(towSpatialRes.body).spatial;
    expect(towSpatial.origin).toBeTruthy();
    expect(towSpatial.current_vehicle).toBeTruthy();
    expect(towSpatial.destination).toBeTruthy();
    expect(towSpatial.transport_location.dispatchId).toBe(dispatchId);
    expect(towSpatial.route_context.etaMinutes).toBe(13);
    expect(towSpatial).not.toHaveProperty('diagnostic_location');
    expect(towSpatial).not.toHaveProperty('provider_location');
    expect(towSpatial).not.toHaveProperty('parts_origin');
    // A provider must never see every competing provider's own distance/ETA for this case.
    expect(towSpatial.route_context).not.toHaveProperty('candidates');

    const strangerSpatialRes = await app.inject({
      method: 'GET',
      url: `/api/maintenance/cases/${caseId}/spatial`,
      headers: actorHeaders('tow', strangerTowActorId)
    });
    expect(strangerSpatialRes.statusCode).toBe(403);

    const customerSpatialRes = await app.inject({
      method: 'GET',
      url: `/api/maintenance/cases/${caseId}/spatial`,
      headers: actorHeaders('customer', customerActorId)
    });
    expect(customerSpatialRes.statusCode).toBe(200);
    const customerSpatial = JSON.parse(customerSpatialRes.body).spatial;
    expect(customerSpatial.origin).toBeTruthy();
    expect(customerSpatial.destination).toBeTruthy();
    expect(customerSpatial.transport_location.dispatchId).toBe(dispatchId);
    expect(customerSpatial).not.toHaveProperty('diagnostic_location');
    expect(customerSpatial).not.toHaveProperty('parts_origin');
    expect(customerSpatial.route_context).not.toHaveProperty('candidates');

    const adminSpatialRes = await app.inject({
      method: 'GET',
      url: `/api/maintenance/cases/${caseId}/spatial`,
      headers: adminHeaders()
    });
    expect(adminSpatialRes.statusCode).toBe(200);
    const adminSpatial = JSON.parse(adminSpatialRes.body).spatial;
    expect(adminSpatial.route_context.candidates[towActorId].etaMinutes).toBe(13);
  });
});
