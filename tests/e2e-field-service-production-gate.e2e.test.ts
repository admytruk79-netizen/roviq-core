import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// Executable form of the ten-point field-service production gate in
// docs/RELEASE_READINESS_2026-08-30.md. Each `describe` block is one gate item; field repair must
// stay pilot/controlled unless every block here passes.

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const INTAKE_GPS = { lat: 45.5231, lng: -122.6765 };
const SAFETY_FLAGS = ['fireRisk', 'fuelLeak', 'highVoltageRisk', 'brakeSteeringRisk', 'unstableVehicle', 'roadsideUnsafe'] as const;

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('field-service production gate', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let operatorActorId: string;
  let strangerCustomerActorId: string;
  let strangerTowActorId: string;

  async function createActor(actorType: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType } });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).actor.id as string;
  }

  async function setOperatorProfile(actorId: string, overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'PUT', url: `/api/admin/field-service/actors/${actorId}/capabilities`, headers: adminHeaders(),
      payload: {
        active: true, repairClasses: ['battery', 'tire'], capabilities: ['battery_service'], tools: ['jump_pack'],
        maxEstimatedMinutes: 90, maxEstimatedCost: 300, ...overrides
      }
    });
    expect(res.statusCode).toBe(200);
  }

  // A customer case with precise intake GPS, a tow dispatch that inherits pickup from it, and the
  // on-scene operator assigned to that dispatch (the operator's relation to the case).
  async function createAssignedCase(assignee = operatorActorId): Promise<{ caseId: string; dispatchId: string }> {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal', location: INTAKE_GPS }
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId = JSON.parse(demandRes.body).case.id as string;
    const pending = await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState: 'tow_pending' } });
    expect(pending.statusCode).toBe(200);
    const dispatchRes = await app.inject({
      method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
      payload: { caseId, transportType: 'tow', dropoffLocation: { lat: 45.54, lng: -122.65 } }
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatchId = JSON.parse(dispatchRes.body).dispatch.id as string;
    const assignRes = await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(), payload: { providerActorId: assignee } });
    expect(assignRes.statusCode).toBe(200);
    return { caseId, dispatchId };
  }

  // A clean, fully supported battery assessment; each gate overrides exactly the input it tests.
  function assessment(overrides: Record<string, unknown> = {}) {
    return {
      operatorActorId, summary: 'Battery failed; on-site replacement possible',
      repairClass: 'battery', drivability: 'drivable', confidence: 0.9, safety: {},
      requiredCapabilities: ['battery_service'], requiredTools: ['jump_pack'], estimatedMinutes: 45,
      ...overrides
    };
  }

  async function assess(caseId: string, overrides: Record<string, unknown> = {}, headers = actorHeaders('tow', operatorActorId)) {
    return app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers, payload: assessment(overrides) });
  }

  async function assessDecision(caseId: string, overrides: Record<string, unknown> = {}) {
    const res = await assess(caseId, overrides);
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).decision as { id: string; action: string; status: string };
  }

  async function authorize(caseId: string, decisionId: string, headers = actorHeaders('customer', customerActorId), approved = true) {
    return app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decisionId}/authorize`, headers, payload: { approved } });
  }

  async function start(caseId: string, decisionId: string, headers = actorHeaders('tow', operatorActorId)) {
    return app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decisionId}/start`, headers });
  }

  async function complete(caseId: string, decisionId: string, outcome: string, headers = actorHeaders('tow', operatorActorId), evidence?: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/${decisionId}/complete`, headers, payload: { outcome, evidence } });
  }

  // Neither the operator nor an admin can start a decision whose Core action is not executable.
  async function expectNotStartable(caseId: string, decisionId: string) {
    const operatorStart = await start(caseId, decisionId);
    expect(operatorStart.statusCode).toBe(409);
    const adminStart = await start(caseId, decisionId, adminHeaders());
    expect(adminStart.statusCode).toBe(409);
    const row = await pool.query('select status,started_at from field_service_decisions where id=$1', [decisionId]);
    expect(row.rows[0].status).not.toBe('in_progress');
    expect(row.rows[0].started_at).toBeNull();
  }

  beforeAll(async () => {
    app = await buildApp();
    customerActorId = await createActor('customer');
    operatorActorId = await createActor('tow');
    strangerCustomerActorId = await createActor('customer');
    strangerTowActorId = await createActor('tow');
    await setOperatorProfile(operatorActorId);
    await setOperatorProfile(strangerTowActorId);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('1. unsafe safety flags always produce tow_required', () => {
    for (const flag of SAFETY_FLAGS) {
      it(`${flag} routes to tow_required even with an otherwise fully supported repair`, async () => {
        const { caseId } = await createAssignedCase();
        const decision = await assessDecision(caseId, { safety: { [flag]: true } });
        expect(decision.action).toBe('tow_required');
        expect(decision.status).toBe('proposed');
        await expectNotStartable(caseId, decision.id);
      });
    }

    it('an admin-issued assessment cannot override a safety flag either', async () => {
      const { caseId } = await createAssignedCase();
      const res = await assess(caseId, { safety: { fuelLeak: true }, customerAuthorizationRequired: false }, adminHeaders());
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).decision.action).toBe('tow_required');
    });
  });

  describe('2. non_drivable always produces tow_required', () => {
    it('routes non_drivable to tow_required regardless of confidence, capability and parts', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId, { drivability: 'non_drivable', confidence: 1 });
      expect(decision.action).toBe('tow_required');
      await expectNotStartable(caseId, decision.id);
    });
  });

  describe('3. confidence below the policy threshold cannot start repair', () => {
    it('sends confidence just under 0.75 to remote_review, which neither operator nor admin can start', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId, { confidence: 0.7499 });
      expect(decision.action).toBe('remote_review');
      await expectNotStartable(caseId, decision.id);
    });

    it('treats the threshold itself (0.75) as sufficient confidence', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId, { confidence: 0.75 });
      expect(decision.action).toBe('field_repair');
    });

    it('sends an unknown repair class to remote_review even at high confidence', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId, { repairClass: 'unknown', confidence: 0.99 });
      expect(decision.action).toBe('remote_review');
      await expectNotStartable(caseId, decision.id);
    });
  });

  describe('4. missing operator capability, tool or part cannot start repair', () => {
    const gaps: [string, Record<string, unknown>][] = [
      ['repair class the operator is not verified for', { repairClass: 'ignition' }],
      ['capability the operator lacks', { requiredCapabilities: ['battery_service', 'high_voltage_certified'] }],
      ['tool the operator lacks', { requiredTools: ['jump_pack', 'wheel_dolly'] }],
      ['job longer than the operator is verified for', { estimatedMinutes: 120 }],
      ['job costlier than the operator is verified for', { estimatedCost: 500 }]
    ];
    for (const [label, overrides] of gaps) {
      it(`a ${label} routes to dispatch_field_technician and cannot start`, async () => {
        const { caseId } = await createAssignedCase();
        const decision = await assessDecision(caseId, overrides);
        expect(decision.action).toBe('dispatch_field_technician');
        await expectNotStartable(caseId, decision.id);
      });
    }

    it('a required part no supplier can cover routes to dispatch_field_technician and cannot start', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId, { requiredParts: [{ sku: `gate-missing-${caseId}`, quantity: 1 }] });
      expect(decision.action).toBe('dispatch_field_technician');
      await expectNotStartable(caseId, decision.id);
    });

    it('an operator whose profile is not verified gets dispatch_field_technician', async () => {
      const unverified = await createActor('tow');
      const { caseId } = await createAssignedCase();
      // Admin names an operator that has no capability profile at all.
      const res = await assess(caseId, { operatorActorId: unverified }, adminHeaders());
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).decision.action).toBe('dispatch_field_technician');
    });

    it('a capability revoked between assessment and start blocks the start', async () => {
      const revokedOperator = await createActor('tow');
      await setOperatorProfile(revokedOperator);
      const { caseId } = await createAssignedCase(revokedOperator);

      const res = await assess(caseId, { operatorActorId: revokedOperator }, actorHeaders('tow', revokedOperator));
      expect(res.statusCode).toBe(201);
      const decision = JSON.parse(res.body).decision;
      expect(decision.action).toBe('field_repair');
      expect((await authorize(caseId, decision.id)).statusCode).toBe(200);

      // Admin withdraws the tool the decision depends on before the operator starts.
      await setOperatorProfile(revokedOperator, { tools: [] });
      const blocked = await start(caseId, decision.id, actorHeaders('tow', revokedOperator));
      expect(blocked.statusCode).toBe(409);
      expect(JSON.parse(blocked.body).error).toBe('field_service_operator_not_eligible');

      // Deactivating the profile is reported distinctly.
      await setOperatorProfile(revokedOperator, { active: false });
      const inactive = await start(caseId, decision.id, actorHeaders('tow', revokedOperator));
      expect(inactive.statusCode).toBe(409);
      expect(JSON.parse(inactive.body).error).toBe('field_service_operator_not_verified');

      // Restoring the capability makes the same authorized decision startable again.
      await setOperatorProfile(revokedOperator);
      expect((await start(caseId, decision.id, actorHeaders('tow', revokedOperator))).statusCode).toBe(200);
    });
  });

  describe('5. customer authorization is enforced when required', () => {
    it('defaults to requiring authorization, and the operator cannot start before the customer approves', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId);
      expect(decision.action).toBe('field_repair');
      expect(decision.status).toBe('authorization_required');
      expect((await start(caseId, decision.id)).statusCode).toBe(409);
    });

    it('rejects an operator waiving customer authorization on their own assessment', async () => {
      const { caseId } = await createAssignedCase();
      const res = await assess(caseId, { customerAuthorizationRequired: false });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('customer_authorization_waiver_forbidden');
      const rows = await pool.query('select 1 from field_service_decisions where case_id=$1', [caseId]);
      expect(rows.rowCount).toBe(0);
    });

    it('does not let the operator authorize its own decision', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId);
      expect((await authorize(caseId, decision.id, actorHeaders('tow', operatorActorId))).statusCode).toBe(403);
      expect((await start(caseId, decision.id)).statusCode).toBe(409);
    });

    it('a declined decision can never start, and cannot be re-approved', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId);
      const declined = await authorize(caseId, decision.id, actorHeaders('customer', customerActorId), false);
      expect(declined.statusCode).toBe(200);
      expect(JSON.parse(declined.body).decision.status).toBe('declined');
      expect((await start(caseId, decision.id)).statusCode).toBe(409);
      expect((await authorize(caseId, decision.id)).statusCode).toBe(409);
    });

    it('an admin may issue a decision without customer authorization under configured policy', async () => {
      const { caseId } = await createAssignedCase();
      const res = await assess(caseId, { customerAuthorizationRequired: false }, adminHeaders());
      expect(res.statusCode).toBe(201);
      const decision = JSON.parse(res.body).decision;
      expect(decision.status).toBe('proposed');
      expect((await start(caseId, decision.id)).statusCode).toBe(200);
    });
  });

  describe('6. unrelated actors cannot read or mutate a field-service decision', () => {
    it('rejects every read and mutation from a stranger tow operator and a stranger customer', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId);
      const strangerTow = actorHeaders('tow', strangerTowActorId);
      const strangerCustomer = actorHeaders('customer', strangerCustomerActorId);

      for (const headers of [strangerTow, strangerCustomer]) {
        const read = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/field-service`, headers });
        expect(read.statusCode).toBe(403);
      }
      expect((await assess(caseId, { operatorActorId: strangerTowActorId }, strangerTow)).statusCode).toBe(403);
      // The on-scene operator cannot name someone else as the operator either.
      expect((await assess(caseId, { operatorActorId: strangerTowActorId })).statusCode).toBe(403);
      expect((await authorize(caseId, decision.id, strangerCustomer)).statusCode).toBe(403);

      expect((await authorize(caseId, decision.id)).statusCode).toBe(200);
      expect((await start(caseId, decision.id, strangerTow)).statusCode).toBe(403);
      expect((await start(caseId, decision.id)).statusCode).toBe(200);
      expect((await complete(caseId, decision.id, 'fixed', strangerTow)).statusCode).toBe(403);

      const row = await pool.query('select status,outcome from field_service_decisions where id=$1', [decision.id]);
      expect(row.rows[0]).toMatchObject({ status: 'in_progress', outcome: null });
    });

    it('does not expose a decision on one case through another case the actor can access', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId);
      const other = await createAssignedCase();
      // Same operator, same customer, but the decision id belongs to a different case.
      expect((await authorize(other.caseId, decision.id)).statusCode).toBe(404);
      expect((await start(other.caseId, decision.id)).statusCode).toBe(404);
    });
  });

  describe('7. an authorized field repair can start and complete with evidence', () => {
    it('records evidence, outcome and the full event trail on the case', async () => {
      const { caseId } = await createAssignedCase();
      const decision = await assessDecision(caseId);
      expect((await authorize(caseId, decision.id)).statusCode).toBe(200);
      const started = await start(caseId, decision.id);
      expect(started.statusCode).toBe(200);
      expect(JSON.parse(started.body).decision.started_at).toBeTruthy();

      const done = await complete(caseId, decision.id, 'fixed', actorHeaders('tow', operatorActorId), { photo: 'battery-installed.jpg', voltage: 12.7 });
      expect(done.statusCode).toBe(200);
      const completed = JSON.parse(done.body).decision;
      expect(completed).toMatchObject({ status: 'completed', outcome: 'fixed' });
      expect(completed.completed_at).toBeTruthy();
      expect(completed.evidence).toMatchObject({ photo: 'battery-installed.jpg', voltage: 12.7 });

      const events = await pool.query(
        `select event_type from events where aggregate_id=$1 and event_type like 'FIELD_SERVICE_%' order by occurred_at`, [caseId]
      );
      expect(events.rows.map((r) => r.event_type)).toEqual([
        'FIELD_SERVICE_DECISION_PROPOSED', 'FIELD_SERVICE_AUTHORIZED', 'FIELD_SERVICE_STARTED', 'FIELD_SERVICE_COMPLETED'
      ]);
      const snapshot = await pool.query('select customer_status from case_snapshots where case_id=$1', [caseId]);
      expect(snapshot.rows[0].customer_status).toBe('field_service_fixed');
    });
  });

  describe('8. failed or escalated work returns to an actionable service path', () => {
    for (const outcome of ['failed', 'escalated'] as const) {
      it(`a ${outcome} outcome escalates without orphaning the case`, async () => {
        const { caseId } = await createAssignedCase();
        const before = await pool.query('select state from service_cases where id=$1', [caseId]);
        const decision = await assessDecision(caseId);
        expect((await authorize(caseId, decision.id)).statusCode).toBe(200);
        expect((await start(caseId, decision.id)).statusCode).toBe(200);
        const res = await complete(caseId, decision.id, outcome);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).decision).toMatchObject({ status: 'escalated', outcome });

        // The case itself is untouched by the failed field attempt: still open, same state.
        const after = await pool.query('select state from service_cases where id=$1', [caseId]);
        expect(after.rows[0].state).toBe(before.rows[0].state);
        const snapshot = await pool.query('select customer_status,next_action from case_snapshots where case_id=$1', [caseId]);
        expect(snapshot.rows[0].customer_status).toBe('field_service_escalated');
        expect(snapshot.rows[0].next_action).toMatch(/towing or specialist/);

        // The escalated decision is closed for good...
        expect((await start(caseId, decision.id)).statusCode).toBe(409);
        expect((await complete(caseId, decision.id, 'fixed')).statusCode).toBe(409);

        // ...and the case can continue: a new transport dispatch and a fresh assessment both work.
        const nextDispatch = await app.inject({ method: 'POST', url: '/api/admin/transport', headers: adminHeaders(), payload: { caseId, transportType: 'tow' } });
        expect(nextDispatch.statusCode).toBe(201);
        const reassessed = await assessDecision(caseId, { drivability: 'non_drivable' });
        expect(reassessed.action).toBe('tow_required');
      });
    }
  });

  describe('9. transport dispatch inherits the case GPS', () => {
    it('uses the precise intake GPS as pickup when the dispatch omits one', async () => {
      const { dispatchId } = await createAssignedCase();
      const row = await pool.query('select pickup_location,metadata from transport_dispatches where id=$1', [dispatchId]);
      expect(row.rows[0].pickup_location).toMatchObject(INTAKE_GPS);
      expect(row.rows[0].metadata.pickupSource).toBe('case_current_vehicle');
      expect(row.rows[0].metadata.locationStatus).toBe('ready');
    });

    it('keeps an explicit dispatch pickup instead of the case GPS', async () => {
      const { caseId } = await createAssignedCase();
      const explicit = { lat: 45.6, lng: -122.7 };
      const res = await app.inject({
        method: 'POST', url: '/api/admin/transport', headers: adminHeaders(),
        payload: { caseId, transportType: 'tow', pickupLocation: explicit }
      });
      expect(res.statusCode).toBe(201);
      const dispatch = JSON.parse(res.body).dispatch;
      expect(dispatch.pickup_location).toMatchObject(explicit);
      expect(dispatch.metadata.pickupSource).toBe('explicit_dispatch');
    });
  });

  describe('10. declined transport leaves the declining provider and becomes reassignable', () => {
    it('releases the dispatch to requested, clears ownership, and lets another provider take it', async () => {
      const { caseId, dispatchId } = await createAssignedCase();
      const decline = await app.inject({
        method: 'POST', url: `/api/transport/${dispatchId}/status`, headers: actorHeaders('tow', operatorActorId),
        payload: { status: 'declined' }
      });
      expect(decline.statusCode).toBe(200);

      const released = await pool.query('select status,provider_actor_id from transport_dispatches where id=$1', [dispatchId]);
      expect(released.rows[0]).toMatchObject({ status: 'requested', provider_actor_id: null });
      const owner = await pool.query('select current_owner_actor_id from service_cases where id=$1', [caseId]);
      expect(owner.rows[0].current_owner_actor_id).not.toBe(operatorActorId);

      // The declining provider no longer has access to the case through that dispatch.
      const declinerRead = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/field-service`, headers: actorHeaders('tow', operatorActorId) });
      expect(declinerRead.statusCode).toBe(403);

      const reassign = await app.inject({ method: 'POST', url: `/api/admin/transport/${dispatchId}/assign`, headers: adminHeaders(), payload: { providerActorId: strangerTowActorId } });
      expect(reassign.statusCode).toBe(200);
      const reassigned = await pool.query('select status,provider_actor_id from transport_dispatches where id=$1', [dispatchId]);
      expect(reassigned.rows[0].provider_actor_id).toBe(strangerTowActorId);
      const newOperatorRead = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/field-service`, headers: actorHeaders('tow', strangerTowActorId) });
      expect(newOperatorRead.statusCode).toBe(200);
    });
  });
});
