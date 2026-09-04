import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  async function createCaseWithTowRelation(): Promise<string> {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState: 'tow_pending' } });
    const dispatchRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', pickupLocation: { lat: 45.52, lng: -122.67 }, dropoffLocation: { lat: 45.54, lng: -122.65 } }
    });
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;
    await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(), payload: { providerActorId: towActorId } });
    return caseId;
  }

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

  it('blocks restarting or re-authorizing a decision once it has left its startable state', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    // Give towActorId a transport_dispatches relation to this case so it clears loadCaseForPrincipal.
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState: 'tow_pending' } });
    const dispatchRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', pickupLocation: { lat: 45.52, lng: -122.67 }, dropoffLocation: { lat: 45.54, lng: -122.65 } }
    });
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;
    await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(), payload: { providerActorId: towActorId } });

    await app.inject({
      method: 'PUT', url: `/api/admin/field-service/actors/${towActorId}/capabilities`, headers: adminHeaders(),
      payload: { active: true, repairClasses: ['battery'] }
    });

    // customerAuthorizationRequired:false -> action is directly executable from 'proposed', no
    // customer authorize step in the loop.
    const assessRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: actorHeaders('tow', towActorId),
      payload: {
        operatorActorId: towActorId, summary: 'Dead battery, on-site swap possible',
        repairClass: 'battery', drivability: 'drivable', confidence: 0.9, safety: {},
        customerAuthorizationRequired: false
      }
    });
    expect(assessRes.statusCode).toBe(201);
    const decision = JSON.parse(assessRes.body).decision;
    expect(decision.action).toBe('field_repair');
    expect(decision.status).toBe('proposed');

    const startRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/start`, headers: actorHeaders('tow', towActorId)
    });
    expect(startRes.statusCode).toBe(200);

    // Restarting an already-in-progress decision must not silently re-run 'start'.
    const restartRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/start`, headers: actorHeaders('tow', towActorId)
    });
    expect(restartRes.statusCode).toBe(409);

    const completeRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/complete`, headers: actorHeaders('tow', towActorId),
      payload: { outcome: 'fixed' }
    });
    expect(completeRes.statusCode).toBe(200);
    expect(JSON.parse(completeRes.body).decision.status).toBe('completed');

    // Once completed, 'start' must not revive it (it's no longer 'proposed' or 'authorized').
    const restartAfterCompleteRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/start`, headers: actorHeaders('tow', towActorId)
    });
    expect(restartAfterCompleteRes.statusCode).toBe(409);

    // Completing an already-completed decision must not be accepted a second time either.
    const recompleteRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/complete`, headers: actorHeaders('tow', towActorId),
      payload: { outcome: 'fixed' }
    });
    expect(recompleteRes.statusCode).toBe(409);
  });

  it('rejects authorize/complete from an actor with no real relation to the case, even when named as the decision operator', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    const attacker = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    const attackerActorId = JSON.parse(attacker.body).actor.id;
    await app.inject({
      method: 'PUT', url: `/api/admin/field-service/actors/${attackerActorId}/capabilities`, headers: adminHeaders(),
      payload: { active: true, repairClasses: ['battery'] }
    });

    // Only admin can name an operator other than itself -- this models a decision whose recorded
    // operator has no transport_dispatches (or any other) relation to this case.
    const assessRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: adminHeaders(),
      payload: {
        operatorActorId: attackerActorId, summary: 'Dead battery, on-site swap possible',
        repairClass: 'battery', drivability: 'drivable', confidence: 0.9, safety: {},
        customerAuthorizationRequired: false
      }
    });
    expect(assessRes.statusCode).toBe(201);
    const decision = JSON.parse(assessRes.body).decision;

    // Admin bypasses both the operator-match and case-access checks, so this succeeds even though
    // the attacker itself never could -- matching how a legitimate dispatcher would kick this off.
    const startRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/start`, headers: adminHeaders()
    });
    expect(startRes.statusCode).toBe(200);

    // The attacker is the recorded operator (passes the operator-match check) but has no
    // transport_dispatch, matches_offers, parts_orders, or mobility_allocations row on this case --
    // loadCaseForPrincipal must still reject it.
    const completeRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/complete`, headers: actorHeaders('tow', attackerActorId),
      payload: { outcome: 'fixed' }
    });
    expect(completeRes.statusCode).toBe(403);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not 500 (and does not permanently lock the decision behind a 409) when the post-authorize event log write fails', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    await app.inject({
      method: 'PUT', url: `/api/admin/field-service/actors/${towActorId}/capabilities`, headers: adminHeaders(),
      payload: { active: true, repairClasses: ['electrical_minor'] }
    });
    const assessRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: adminHeaders(),
      payload: {
        operatorActorId: towActorId, summary: 'Minor electrical repair possible on site',
        repairClass: 'electrical_minor', drivability: 'drivable', confidence: 0.9, safety: {},
        customerAuthorizationRequired: true
      }
    });
    expect(assessRes.statusCode).toBe(201);
    const decision = JSON.parse(assessRes.body).decision;
    expect(decision.action).toBe('field_repair');
    expect(decision.status).toBe('authorization_required');

    // Simulate the event-log write failing after the status update has already committed --
    // everything except the events insert passes through to the real pool unchanged.
    const originalQuery = pool.query.bind(pool);
    vi.spyOn(pool, 'query').mockImplementation(((...args: Parameters<typeof pool.query>) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (typeof text === 'string' && text.includes('insert into events')) {
        return Promise.reject(new Error('simulated_event_log_failure'));
      }
      return originalQuery(...(args as Parameters<typeof originalQuery>));
    }) as typeof pool.query);

    // The status update (guarded by `where ... and status='authorization_required'`) has already
    // committed by the time the event-log write fails. The response must still be a success --
    // otherwise the client sees a 500 while the decision is already 'authorized', and every retry
    // is rejected by that same guard with a 409, permanently losing the event with no way to
    // recover it (Devin review finding on this PR).
    const authorizeRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/authorize`, headers: actorHeaders('customer', customerActorId),
      payload: { approved: true }
    });
    expect(authorizeRes.statusCode).toBe(200);
    expect(JSON.parse(authorizeRes.body).decision.status).toBe('authorized');
  });

  it('does not trust a self-declared parts claim: required parts with no supplier inventory force dispatch_field_technician', async () => {
    const caseId = await createCaseWithTowRelation();
    await app.inject({
      method: 'PUT', url: `/api/admin/field-service/actors/${towActorId}/capabilities`, headers: adminHeaders(),
      payload: { active: true, repairClasses: ['battery'] }
    });

    // No parts_inventory row exists anywhere for this sku. The operator asserts partsAvailable:true
    // anyway -- the old client-declared boolean would have blindly trusted exactly this claim and
    // produced field_repair; Core must verify against real inventory instead and refuse it.
    const assessRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: actorHeaders('tow', towActorId),
      payload: {
        operatorActorId: towActorId, summary: 'Dead battery, on-site swap possible',
        repairClass: 'battery', drivability: 'drivable', confidence: 0.9, safety: {},
        customerAuthorizationRequired: false, partsAvailable: true,
        requiredParts: [{ sku: `no-stock-sku-${caseId}`, quantity: 1 }]
      }
    });
    expect(assessRes.statusCode).toBe(201);
    const decision = JSON.parse(assessRes.body).decision;
    expect(decision.action).toBe('dispatch_field_technician');
    expect(decision.metadata.fulfillingSupplierActorId).toBeUndefined();
  });

  it('reserves against the supplier resolved at assessment on start, then consumes stock on a fixed completion', async () => {
    const supplier = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    const supplierActorId = JSON.parse(supplier.body).actor.id as string;
    const sku = `brake-pad-${supplierActorId}`;
    await app.inject({
      method: 'PUT', url: '/api/parts/inventory', headers: adminHeaders(),
      payload: { supplierActorId, sku, quantityOnHand: 5, unitPrice: 20, currency: 'USD' }
    });

    const caseId = await createCaseWithTowRelation();
    await app.inject({
      method: 'PUT', url: `/api/admin/field-service/actors/${towActorId}/capabilities`, headers: adminHeaders(),
      payload: { active: true, repairClasses: ['battery'] }
    });

    const assessRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: actorHeaders('tow', towActorId),
      payload: {
        operatorActorId: towActorId, summary: 'Dead battery, brake pad replacement possible on site',
        repairClass: 'battery', drivability: 'drivable', confidence: 0.9, safety: {},
        customerAuthorizationRequired: false,
        requiredParts: [{ sku, quantity: 2 }]
      }
    });
    expect(assessRes.statusCode).toBe(201);
    const decision = JSON.parse(assessRes.body).decision;
    expect(decision.action).toBe('field_repair');
    expect(decision.metadata.fulfillingSupplierActorId).toBe(supplierActorId);

    const startRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/start`, headers: actorHeaders('tow', towActorId)
    });
    expect(startRes.statusCode).toBe(200);
    const reservedInv = await pool.query('select quantity_on_hand,quantity_reserved from parts_inventory where supplier_actor_id=$1 and sku=$2', [supplierActorId, sku]);
    expect(reservedInv.rows[0].quantity_on_hand).toBe(5);
    expect(reservedInv.rows[0].quantity_reserved).toBe(2);

    const completeRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decision.id}/complete`, headers: actorHeaders('tow', towActorId),
      payload: { outcome: 'fixed' }
    });
    expect(completeRes.statusCode).toBe(200);
    // Completion consumes the reservation: on-hand stock drops along with it.
    const consumedInv = await pool.query('select quantity_on_hand,quantity_reserved from parts_inventory where supplier_actor_id=$1 and sku=$2', [supplierActorId, sku]);
    expect(consumedInv.rows[0].quantity_on_hand).toBe(3);
    expect(consumedInv.rows[0].quantity_reserved).toBe(0);
  });

  it('releases (not consumes) the reservation when the job is not completed, and rejects start once stock can no longer cover it', async () => {
    const supplier = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    const supplierActorId = JSON.parse(supplier.body).actor.id as string;
    const sku = `ignition-coil-${supplierActorId}`;
    await app.inject({
      method: 'PUT', url: '/api/parts/inventory', headers: adminHeaders(),
      payload: { supplierActorId, sku, quantityOnHand: 1, unitPrice: 40, currency: 'USD' }
    });
    await app.inject({
      method: 'PUT', url: `/api/admin/field-service/actors/${towActorId}/capabilities`, headers: adminHeaders(),
      payload: { active: true, repairClasses: ['ignition'] }
    });

    async function assessAndReturnDecision() {
      const caseId = await createCaseWithTowRelation();
      const assessRes = await app.inject({
        method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: actorHeaders('tow', towActorId),
        payload: {
          operatorActorId: towActorId, summary: 'Ignition coil failure, on-site swap possible',
          repairClass: 'ignition', drivability: 'drivable', confidence: 0.9, safety: {},
          customerAuthorizationRequired: false,
          requiredParts: [{ sku, quantity: 1 }]
        }
      });
      expect(assessRes.statusCode).toBe(201);
      const decision = JSON.parse(assessRes.body).decision;
      expect(decision.action).toBe('field_repair');
      return { caseId, decision };
    }

    // Both jobs are assessed while the only unit of stock is still free, so both resolve the
    // same fulfilling supplier and both land on field_repair.
    const first = await assessAndReturnDecision();
    const second = await assessAndReturnDecision();

    const firstStartRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${first.caseId}/field-service/${first.decision.id}/start`, headers: actorHeaders('tow', towActorId)
    });
    expect(firstStartRes.statusCode).toBe(200);

    // The second decision's assessment is now stale: the first job's start already reserved the
    // only unit -- Core must reject rather than let unsupported work begin, even though the
    // assessment itself succeeded.
    const secondStartRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${second.caseId}/field-service/${second.decision.id}/start`, headers: actorHeaders('tow', towActorId)
    });
    expect(secondStartRes.statusCode).toBe(409);
    expect(JSON.parse(secondStartRes.body).error).toBe('field_service_parts_unavailable');

    // The first job fails on site rather than fixing the vehicle -- its reservation releases the
    // part back to available stock instead of consuming it, since nothing was actually installed.
    const failRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${first.caseId}/field-service/${first.decision.id}/complete`, headers: actorHeaders('tow', towActorId),
      payload: { outcome: 'failed' }
    });
    expect(failRes.statusCode).toBe(200);
    const releasedInv = await pool.query('select quantity_on_hand,quantity_reserved from parts_inventory where supplier_actor_id=$1 and sku=$2', [supplierActorId, sku]);
    expect(releasedInv.rows[0].quantity_on_hand).toBe(1);
    expect(releasedInv.rows[0].quantity_reserved).toBe(0);

    // Now that the part is free again, the second job's start succeeds.
    const secondStartRetryRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${second.caseId}/field-service/${second.decision.id}/start`, headers: actorHeaders('tow', towActorId)
    });
    expect(secondStartRetryRes.statusCode).toBe(200);
  });
});
