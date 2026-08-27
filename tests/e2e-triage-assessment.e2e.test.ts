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

describe('AI triage assessment end-to-end lifecycle', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let strangerCustomerId: string;
  let partnerActorId: string;
  let strangerPartnerId: string;
  let caseId: string;

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const strangerCustomer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    strangerCustomerId = JSON.parse(strangerCustomer.body).actor.id;

    const partner = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'shop', domain: 'maintenance' } });
    partnerActorId = JSON.parse(partner.body).actor.id;

    const strangerPartner = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'shop', domain: 'maintenance' } });
    strangerPartnerId = JSON.parse(strangerPartner.body).actor.id;

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'check_engine', urgency: 'normal' }
    });
    caseId = JSON.parse(demandRes.body).case.id;

    // Grants the partner a provider relation to the case (normally set up via the routing/offer flow).
    const c = await pool.query('select demand_id from service_cases where id=$1', [caseId]);
    await pool.query(
      `insert into matches_offers(demand_id,actor_id,case_id,outcome) values($1,$2,$3,'accepted')`,
      [c.rows[0].demand_id, partnerActorId, caseId]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs AI triage, enforces the deterministic safety override, and gates review/actions/outcomes by case access', async () => {
    const runRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/triage/run`, headers: actorHeaders('customer', customerActorId),
      payload: { symptoms: 'Check engine light is on, mild rough idle at stop lights.' }
    });
    expect(runRes.statusCode).toBe(201);
    const run1 = JSON.parse(runRes.body);
    expect(run1.safetyOverride).toBe(false);
    expect(run1.requiresHumanReview).toBe(true);
    expect(run1.result.suggestedDrivability).toBe('unknown');
    expect(run1.result.confidence).toBeCloseTo(0.2);
    expect(run1.result.suggestedActions).toEqual([{ actionType: 'request_diagnostic_review' }]);
    const assessment1Id = run1.assessmentId;

    // A safety-critical symptom forces the engine's own suggestion regardless of confidence.
    const safetyRunRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/triage/run`, headers: actorHeaders('customer', customerActorId),
      payload: { symptoms: 'No brakes at all, brake pedal goes straight to the floor.' }
    });
    expect(safetyRunRes.statusCode).toBe(201);
    const run2 = JSON.parse(safetyRunRes.body);
    expect(run2.safetyOverride).toBe(true);
    expect(run2.requiresHumanReview).toBe(true);
    expect(run2.result.suggestedDrivability).toBe('non_drivable');
    expect(run2.result.safetyFlags.some((f: { code: string; severity: string }) => f.code === 'brake_failure' && f.severity === 'critical')).toBe(true);
    expect(run2.result.suggestedCapabilities).toEqual(expect.arrayContaining(['diagnostics', 'tow']));
    const assessment2Id = run2.assessmentId;

    const forbiddenGetRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/triage`, headers: actorHeaders('customer', strangerCustomerId) });
    expect(forbiddenGetRes.statusCode).toBe(403);

    const getRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/triage`, headers: actorHeaders('customer', customerActorId) });
    expect(getRes.statusCode).toBe(200);
    const triage = JSON.parse(getRes.body);
    expect(triage.assessments.length).toBe(2);
    const persisted1 = triage.assessments.find((a: { id: string }) => a.id === assessment1Id);
    const persisted2 = triage.assessments.find((a: { id: string }) => a.id === assessment2Id);
    expect(persisted1.safety_override).toBe(false);
    expect(persisted2.safety_override).toBe(true);
    expect(persisted1.engine_version).toBe('triage-0.1.0');
    // Each run's conservative fallback proposes its own 'request_diagnostic_review' action.
    expect(triage.actions.length).toBe(2);
    expect(triage.actions.every((a: { state: string }) => a.state === 'suggested')).toBe(true);
    const action1 = triage.actions.find((a: { assessment_id: string }) => a.assessment_id === assessment1Id);
    const actionId = action1.id;

    // Review is gated by case access, not just role: an actor with no relation to the case is forbidden.
    const forbiddenReviewRes = await app.inject({ method: 'POST', url: `/api/triage/${assessment1Id}/review`, headers: actorHeaders('partner', strangerPartnerId), payload: { decision: 'accepted' } });
    expect(forbiddenReviewRes.statusCode).toBe(403);
    const roleForbiddenReviewRes = await app.inject({ method: 'POST', url: `/api/triage/${assessment1Id}/review`, headers: actorHeaders('customer', customerActorId), payload: { decision: 'accepted' } });
    expect(roleForbiddenReviewRes.statusCode).toBe(403);
    const missingReviewRes = await app.inject({ method: 'POST', url: '/api/triage/00000000-0000-0000-0000-000000000000/review', headers: actorHeaders('partner', partnerActorId), payload: { decision: 'accepted' } });
    expect(missingReviewRes.statusCode).toBe(404);

    const reviewRes = await app.inject({ method: 'POST', url: `/api/triage/${assessment1Id}/review`, headers: actorHeaders('partner', partnerActorId), payload: { decision: 'accepted', notes: 'Matches customer-reported symptoms.' } });
    expect(reviewRes.statusCode).toBe(200);
    expect(JSON.parse(reviewRes.body).assessment.status).toBe('accepted');

    const alreadyFinalRes = await app.inject({ method: 'POST', url: `/api/triage/${assessment1Id}/review`, headers: actorHeaders('partner', partnerActorId), payload: { decision: 'rejected' } });
    expect(alreadyFinalRes.statusCode).toBe(409);
    expect(JSON.parse(alreadyFinalRes.body).error).toBe('assessment_already_final');

    // Actions are gated by case access too.
    const forbiddenActionRes = await app.inject({ method: 'POST', url: `/api/triage/actions/${actionId}/decision`, headers: actorHeaders('partner', strangerPartnerId), payload: { decision: 'approved' } });
    expect(forbiddenActionRes.statusCode).toBe(403);
    const missingActionRes = await app.inject({ method: 'POST', url: '/api/triage/actions/00000000-0000-0000-0000-000000000000/decision', headers: actorHeaders('partner', partnerActorId), payload: { decision: 'approved' } });
    expect(missingActionRes.statusCode).toBe(404);

    const actionRes = await app.inject({ method: 'POST', url: `/api/triage/actions/${actionId}/decision`, headers: actorHeaders('partner', partnerActorId), payload: { decision: 'approved' } });
    expect(actionRes.statusCode).toBe(200);
    expect(JSON.parse(actionRes.body).action.state).toBe('approved');

    const actionAlreadyDecidedRes = await app.inject({ method: 'POST', url: `/api/triage/actions/${actionId}/decision`, headers: actorHeaders('partner', partnerActorId), payload: { decision: 'rejected' } });
    expect(actionAlreadyDecidedRes.statusCode).toBe(409);
    expect(JSON.parse(actionAlreadyDecidedRes.body).error).toBe('action_already_decided');

    // Outcome labeling is gated by case access too, and upserts in place on a repeat call.
    const forbiddenOutcomeRes = await app.inject({
      method: 'POST', url: `/api/triage/${assessment2Id}/outcome`, headers: actorHeaders('partner', strangerPartnerId),
      payload: { confirmedDrivability: 'non_drivable' }
    });
    expect(forbiddenOutcomeRes.statusCode).toBe(403);
    const missingOutcomeRes = await app.inject({ method: 'POST', url: '/api/triage/00000000-0000-0000-0000-000000000000/outcome', headers: adminHeaders(), payload: {} });
    expect(missingOutcomeRes.statusCode).toBe(404);

    const outcomeRes = await app.inject({
      method: 'POST', url: `/api/triage/${assessment2Id}/outcome`, headers: adminHeaders(),
      payload: { confirmedDrivability: 'non_drivable', confirmedCapabilities: ['tow', 'diagnostics'], towRequired: true, safetyCritical: true, diagnosticSummary: 'Confirmed brake failure on inspection.' }
    });
    expect(outcomeRes.statusCode).toBe(201);
    expect(JSON.parse(outcomeRes.body).outcome.tow_required).toBe(true);

    const outcomeUpdateRes = await app.inject({
      method: 'POST', url: `/api/triage/${assessment2Id}/outcome`, headers: adminHeaders(),
      payload: { confirmedDrivability: 'non_drivable', confirmedCapabilities: ['tow', 'diagnostics'], towRequired: true, safetyCritical: true, repairSummary: 'Replaced brake master cylinder.' }
    });
    expect(outcomeUpdateRes.statusCode).toBe(201);
    expect(JSON.parse(outcomeUpdateRes.body).outcome.repair_summary).toBe('Replaced brake master cylinder.');
    const outcomeCount = await pool.query('select count(*)::int as count from ai_triage_outcomes where assessment_id=$1', [assessment2Id]);
    expect(outcomeCount.rows[0].count).toBe(1);

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const timelineEvents = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(timelineEvents).toEqual(expect.arrayContaining([
      'AI_TRIAGE_PROPOSED', 'AI_TRIAGE_ACCEPTED', 'AI_TRIAGE_ACTION_APPROVED'
    ]));
  });
});
