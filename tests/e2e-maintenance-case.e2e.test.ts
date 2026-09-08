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

describe('maintenance case end-to-end lifecycle', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let partnerActorId: string;

  beforeAll(async () => {
    app = await buildApp();

    await pool.query(
      `insert into routing_policies(domain_id, policy_key, version, active, configuration)
       select id, 'maintenance_default', 1, true, '{"weights":{"rating":1},"defaults":{"rating":0}}'::jsonb
       from domains where code='maintenance'
       on conflict (domain_id, policy_key, version) do nothing`
    );

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const partner = await app.inject({
      method: 'POST',
      url: '/api/admin/actors',
      headers: adminHeaders(),
      payload: { actorType: 'shop', domain: 'maintenance', attributes: { rating: 1000000 } }
    });
    partnerActorId = JSON.parse(partner.body).actor.id;

    await pool.query(
      `insert into actor_capabilities(actor_id, capability_id) select $1, id from capabilities where capability_code = 'repair'`,
      [partnerActorId]
    );

    // Canonical capacity is organization/location scoped. Give the E2E provider
    // an explicit canonical organization before seeding its repair window.
    const organization = await pool.query(
      `insert into organizations(organization_type,display_name) values('shop','Maintenance E2E Shop') returning id`
    );
    await pool.query(`update actors set organization_id=$2 where id=$1`, [partnerActorId, organization.rows[0].id]);
    const scope = await pool.query(
      `select organization_id,location_id from actors where id=$1`,
      [partnerActorId]
    );
    await pool.query(
      `insert into capacity_windows(
         organization_id,location_id,service_category,window_start,window_end,
         capacity_state,capacity_units,confidence,sync_state
       ) values($1,$2,'repair',now()-interval '5 minutes',now()+interval '2 hours','available',4,'roviq_native','current')`,
      [scope.rows[0]?.organization_id ?? null,scope.rows[0]?.location_id ?? null]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('completes a full customer-to-outcome vertical slice with an auditable trail', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    expect(demandRes.statusCode).toBe(201);
    const { demand, case: openedCase } = JSON.parse(demandRes.body);
    expect(openedCase.state).toBe('triage');
    const caseId = openedCase.id;

    await pool.query("update service_cases set selection_mode='auto_dispatch' where id=$1", [caseId]);

    const adminTransitionsRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/transitions`, headers: adminHeaders() });
    expect(adminTransitionsRes.statusCode).toBe(200);
    const adminTransitions = JSON.parse(adminTransitionsRes.body).transitions.map((t: { toState: string }) => t.toState).sort();
    expect(adminTransitions).toEqual(['cancelled', 'diagnostic_pending', 'provider_selection', 'tow_pending']);

    const customerTransitionsRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/transitions`, headers: actorHeaders('customer', customerActorId) });
    expect(customerTransitionsRes.statusCode).toBe(200);
    expect(JSON.parse(customerTransitionsRes.body).transitions.map((t: { toState: string }) => t.toState)).toEqual(['cancelled']);

    const routeRes = await app.inject({ method: 'POST', url: `/api/admin/demands/${demand.id}/route`, headers: adminHeaders(), payload: {} });
    expect(routeRes.statusCode).toBe(200);
    const routed = JSON.parse(routeRes.body);
    expect(routed.ranked.length).toBeGreaterThan(0);
    expect(routed.offer.actor_id).toBe(partnerActorId);
    expect(routed.case.state).toBe('provider_pending');

    const acceptRes = await app.inject({
      method: 'POST', url: `/api/offers/${routed.offer.id}/respond`, headers: actorHeaders('partner', partnerActorId),
      payload: { outcome: 'accepted' }
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(JSON.parse(acceptRes.body).case.state).toBe('repair_in_progress');

    const partnerTransitionsRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/transitions`, headers: actorHeaders('partner', partnerActorId) });
    expect(partnerTransitionsRes.statusCode).toBe(200);
    expect(JSON.parse(partnerTransitionsRes.body).transitions.map((t: { toState: string }) => t.toState).sort()).toEqual(['parts_pending', 'payment_pending']);

    const revisionRes = await app.inject({
      method: 'POST', url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`, headers: adminHeaders(),
      payload: {
        changeReason: 'Diagnosed worn front brake pads', estimatedTotalMinor: 24999, currency: 'usd',
        tasks: [{ taskType: 'repair', title: 'Replace front brake pads', estimatedAmountMinor: 24999 }]
      }
    });
    expect(revisionRes.statusCode).toBe(201);
    const revised = JSON.parse(revisionRes.body);
    expect(revised.plan.status).toBe('proposed');
    expect(revised.plan.pendingApproval.state).toBe('pending');
    const approvalId = revised.plan.pendingApproval.id;

    const toPaymentRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: actorHeaders('partner', partnerActorId),
      payload: { toState: 'payment_pending' }
    });
    expect(toPaymentRes.statusCode).toBe(200);
    expect(JSON.parse(toPaymentRes.body).case.state).toBe('payment_pending');

    const prematurePaymentRes = await app.inject({
      method: 'POST', url: '/api/admin/payments', headers: adminHeaders(),
      payload: { caseId, amount: 249.99, currency: 'USD', description: 'Front brake pad replacement' }
    });
    expect(prematurePaymentRes.statusCode).toBe(409);
    expect(JSON.parse(prematurePaymentRes.body).error).toBe('quote_not_approved');

    const strangerDecisionRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${approvalId}/decision`, headers: actorHeaders('partner', partnerActorId),
      payload: { decision: 'approved' }
    });
    expect(strangerDecisionRes.statusCode).toBe(403);

    const decisionRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${approvalId}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'approved' }
    });
    expect(decisionRes.statusCode).toBe(200);
    expect(JSON.parse(decisionRes.body).approval.state).toBe('approved');

    const paymentRes = await app.inject({
      method: 'POST', url: '/api/admin/payments', headers: adminHeaders(),
      payload: { caseId, amount: 249.99, currency: 'USD', description: 'Front brake pad replacement' }
    });
    expect(paymentRes.statusCode).toBe(201);
    const paymentId = JSON.parse(paymentRes.body).payment.id;

    const captureRes = await app.inject({
      method: 'POST', url: `/api/admin/payments/${paymentId}/state`, headers: adminHeaders(), payload: { state: 'captured' }
    });
    expect(captureRes.statusCode).toBe(200);
    expect(JSON.parse(captureRes.body).payment.state).toBe('captured');

    const finalCaseRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: actorHeaders('customer', customerActorId) });
    expect(finalCaseRes.statusCode).toBe(200);
    expect(JSON.parse(finalCaseRes.body).case.state).toBe('completed');

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const timelineEvents = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(timelineEvents).toEqual(expect.arrayContaining([
      'CASE_CREATED', 'SERVICE_PLAN_CREATED', 'CASE_TRIAGE', 'CASE_PROVIDER_SELECTION', 'CASE_PROVIDER_PENDING',
      'CASE_REPAIR_IN_PROGRESS', 'SERVICE_PLAN_REVISED', 'CASE_PAYMENT_PENDING', 'CASE_APPROVAL_DECIDED', 'PAYMENT_INTENT_CREATED', 'CASE_COMPLETED'
    ]));

    const planRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/service-plan`, headers: actorHeaders('customer', customerActorId) });
    const plan = JSON.parse(planRes.body);
    expect(plan.plan.status).toBe('proposed');
    expect(plan.tasks.length).toBe(1);
    expect(plan.approvals.length).toBe(1);
    expect(plan.approvals[0].state).toBe('approved');

    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const strangerId = JSON.parse(stranger.body).actor.id;
    const forbiddenRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: actorHeaders('customer', strangerId) });
    expect(forbiddenRes.statusCode).toBe(403);

    const myCasesRes = await app.inject({ method: 'GET', url: '/api/customers/me/cases', headers: actorHeaders('customer', customerActorId) });
    expect(myCasesRes.statusCode).toBe(200);
    const myCases = JSON.parse(myCasesRes.body).cases;
    expect(myCases.some((c: { id: string }) => c.id === caseId)).toBe(true);
    const strangerCasesRes = await app.inject({ method: 'GET', url: '/api/customers/me/cases', headers: actorHeaders('customer', strangerId) });
    expect(JSON.parse(strangerCasesRes.body).cases.some((c: { id: string }) => c.id === caseId)).toBe(false);

    const adminAllRes = await app.inject({ method: 'GET', url: '/api/admin/cases', headers: adminHeaders() });
    expect(adminAllRes.statusCode).toBe(200);
    const adminAllCases = JSON.parse(adminAllRes.body).cases;
    expect(adminAllCases.some((c: { id: string }) => c.id === caseId)).toBe(true);
    expect(adminAllCases.some((c: { id: string }) => c.id === caseId && c.customer_actor_id === customerActorId)).toBe(true);

    const adminCompletedRes = await app.inject({ method: 'GET', url: '/api/admin/cases?state=completed', headers: adminHeaders() });
    expect(adminCompletedRes.statusCode).toBe(200);
    const adminCompletedCases = JSON.parse(adminCompletedRes.body).cases;
    expect(adminCompletedCases.some((c: { id: string }) => c.id === caseId)).toBe(true);
    expect(adminCompletedCases.every((c: { state: string }) => c.state === 'completed')).toBe(true);

    const adminIntakeRes = await app.inject({ method: 'GET', url: '/api/admin/cases?state=intake', headers: adminHeaders() });
    expect(JSON.parse(adminIntakeRes.body).cases.some((c: { id: string }) => c.id === caseId)).toBe(false);

    const nonAdminRes = await app.inject({ method: 'GET', url: '/api/admin/cases', headers: actorHeaders('customer', customerActorId) });
    expect(nonAdminRes.statusCode).toBe(403);
  });

  it('rejects a decision on an approval once its plan has moved to a newer revision', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    const rev1Res = await app.inject({
      method: 'POST', url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`, headers: adminHeaders(),
      payload: { changeReason: 'Initial estimate', estimatedTotalMinor: 10000, currency: 'usd' }
    });
    expect(rev1Res.statusCode).toBe(201);
    const rev1ApprovalId = JSON.parse(rev1Res.body).plan.pendingApproval.id as string;

    const rev2Res = await app.inject({
      method: 'POST', url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`, headers: adminHeaders(),
      payload: { changeReason: 'Found additional wear', estimatedTotalMinor: 18000, currency: 'usd' }
    });
    expect(rev2Res.statusCode).toBe(201);
    const rev2ApprovalId = JSON.parse(rev2Res.body).plan.pendingApproval.id as string;

    const staleDecisionRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${rev1ApprovalId}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'approved' }
    });
    expect(staleDecisionRes.statusCode).toBe(409);
    expect(JSON.parse(staleDecisionRes.body).error).toBe('approval_revision_stale');

    const currentDecisionRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${rev2ApprovalId}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'approved' }
    });
    expect(currentDecisionRes.statusCode).toBe(200);
    expect(JSON.parse(currentDecisionRes.body).approval.state).toBe('approved');
  });
});
