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

describe('mobility allocation end-to-end lifecycle', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let strangerCustomerId: string;
  let fleetActorId: string;
  let strangerFleetActorId: string;

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    strangerCustomerId = JSON.parse(stranger.body).actor.id;

    const fleet = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'fleet' } });
    fleetActorId = JSON.parse(fleet.body).actor.id;

    const strangerFleet = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'fleet' } });
    strangerFleetActorId = JSON.parse(strangerFleet.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('completes a full loaner allocation vertical slice with enforced access and resource state', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId = JSON.parse(demandRes.body).case.id;

    // A customer with no relation to the case cannot request mobility for it.
    const forbiddenRequestRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/mobility`, headers: actorHeaders('customer', strangerCustomerId),
      payload: { allocationType: 'loaner' }
    });
    expect(forbiddenRequestRes.statusCode).toBe(403);

    const requestRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/mobility`, headers: actorHeaders('customer', customerActorId),
      payload: { allocationType: 'loaner', notes: 'Prefers a sedan' }
    });
    expect(requestRes.statusCode).toBe(201);
    const allocation = JSON.parse(requestRes.body).allocation;
    expect(allocation.state).toBe('requested');
    const allocationId = allocation.id;

    // A second, never-assigned allocation to exercise the invalid-transition and resource-conflict paths.
    const secondRequestRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/mobility`, headers: actorHeaders('customer', customerActorId),
      payload: { allocationType: 'loaner' }
    });
    const secondAllocationId = JSON.parse(secondRequestRes.body).allocation.id;

    const resourceRes = await app.inject({
      method: 'POST', url: '/api/admin/mobility/resources', headers: adminHeaders(),
      payload: { actorId: fleetActorId, resourceType: 'loaner', label: 'Loaner #1' }
    });
    expect(resourceRes.statusCode).toBe(201);
    const resourceId = JSON.parse(resourceRes.body).resource.id;

    const strangerResourceRes = await app.inject({
      method: 'POST', url: '/api/admin/mobility/resources', headers: adminHeaders(),
      payload: { actorId: strangerFleetActorId, resourceType: 'loaner', label: 'Someone else\'s loaner' }
    });
    const strangerResourceId = JSON.parse(strangerResourceRes.body).resource.id;

    // Assigning a resource that belongs to a different provider than the one being assigned must be rejected.
    const mismatchRes = await app.inject({
      method: 'POST', url: `/api/admin/mobility/${allocationId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: fleetActorId, resourceId: strangerResourceId }
    });
    expect(mismatchRes.statusCode).toBe(409);
    expect(JSON.parse(mismatchRes.body).error).toBe('resource_provider_mismatch');

    const assignRes = await app.inject({
      method: 'POST', url: `/api/admin/mobility/${allocationId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: fleetActorId, resourceId }
    });
    expect(assignRes.statusCode).toBe(200);
    expect(JSON.parse(assignRes.body).allocation.state).toBe('assigned');

    // The resource is now taken and cannot be handed to a second allocation.
    const availableAfterAssignRes = await app.inject({ method: 'GET', url: '/api/mobility/resources/available', headers: adminHeaders() });
    const availableIds = JSON.parse(availableAfterAssignRes.body).resources.map((r: { id: string }) => r.id);
    expect(availableIds).not.toContain(resourceId);

    const conflictRes = await app.inject({
      method: 'POST', url: `/api/admin/mobility/${secondAllocationId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: fleetActorId, resourceId }
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(JSON.parse(conflictRes.body).error).toBe('resource_unavailable');

    // An unrelated fleet provider cannot act on someone else's allocation.
    const strangerStateRes = await app.inject({
      method: 'POST', url: `/api/mobility/${allocationId}/state`, headers: actorHeaders('fleet', strangerFleetActorId),
      payload: { state: 'active' }
    });
    expect(strangerStateRes.statusCode).toBe(403);

    // Skipping straight from 'requested' to 'active' on the never-assigned allocation is invalid.
    const invalidTransitionRes = await app.inject({
      method: 'POST', url: `/api/mobility/${secondAllocationId}/state`, headers: adminHeaders(),
      payload: { state: 'active' }
    });
    expect(invalidTransitionRes.statusCode).toBe(409);
    expect(JSON.parse(invalidTransitionRes.body).error).toBe('invalid_allocation_transition');

    for (const state of ['active', 'return_pending', 'completed']) {
      const res = await app.inject({
        method: 'POST', url: `/api/mobility/${allocationId}/state`, headers: actorHeaders('fleet', fleetActorId),
        payload: { state }
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).allocation.state).toBe(state);
    }

    // Completion frees the resource back up for the next allocation.
    const availableAfterCompleteRes = await app.inject({ method: 'GET', url: '/api/mobility/resources/available', headers: adminHeaders() });
    const availableIdsAfterComplete = JSON.parse(availableAfterCompleteRes.body).resources.map((r: { id: string }) => r.id);
    expect(availableIdsAfterComplete).toContain(resourceId);

    const meAllocationsRes = await app.inject({ method: 'GET', url: '/api/mobility/me/allocations', headers: actorHeaders('fleet', fleetActorId) });
    expect(meAllocationsRes.statusCode).toBe(200);
    expect(JSON.parse(meAllocationsRes.body).allocations.some((a: { id: string }) => a.id === allocationId)).toBe(false); // completed, no longer active

    const forbiddenListRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/mobility`, headers: actorHeaders('customer', strangerCustomerId) });
    expect(forbiddenListRes.statusCode).toBe(403);

    const listRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/mobility`, headers: actorHeaders('customer', customerActorId) });
    expect(listRes.statusCode).toBe(200);
    const allocations = JSON.parse(listRes.body).allocations;
    expect(allocations.length).toBe(2);
    expect(allocations.find((a: { id: string }) => a.id === allocationId).state).toBe('completed');

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const timelineEvents = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(timelineEvents).toEqual(expect.arrayContaining([
      'MOBILITY_REQUESTED', 'MOBILITY_ASSIGNED', 'MOBILITY_ACTIVE', 'MOBILITY_RETURN_PENDING', 'MOBILITY_COMPLETED'
    ]));
  });
});
