import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;

function adminHeaders() { return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY }; }
function actorHeaders(role: string, actorId: string) { return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId }; }

// Business Plan Section 4: the on-site diagnostic visit itself was never a monetized event --
// this exercises the standalone diagnostic coordination fee (charged on finding submission,
// regardless of disposition) and the consumer membership tiers that can waive it out of a
// per-period quota and unlock a higher loaner tier.
describe('diagnostic coordination fee and consumer membership', () => {
  let app: FastifyInstance;
  let diagnosticId: string;

  async function setDiagnosticFeeActive(active: boolean, amountMinor = 2500) {
    await pool.query(
      `insert into routing_policies(domain_id, policy_key, version, active, configuration)
       select id, 'diagnostic_fee_default', 1, $1, jsonb_build_object('amountMinor',$2::int,'currency','USD')
       from domains where code='maintenance'
       on conflict (domain_id, policy_key, version) do update set active=excluded.active,configuration=excluded.configuration,updated_at=now()`,
      [active, amountMinor]
    );
  }

  async function openCaseWithAcceptedDiagnostic(customerId: string) {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'check_engine_light', urgency: 'normal' }
    });
    const opened = JSON.parse(demandRes.body);
    const demandId = opened.demand.id as string;
    const caseId = opened.case.id as string;
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState: 'diagnostic_pending' } });
    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,rank,outcome,responded_at,rule_basis)
       values($1,$2,$3,1,'accepted',now(),'diagnostic_fee_test_seed')`,
      [demandId, caseId, diagnosticId]
    );
    return { demandId, caseId };
  }

  async function submitFinding(demandId: string) {
    return app.inject({
      method: 'POST', url: `/api/diagnostics/demands/${demandId}/findings`, headers: actorHeaders('diagnostic', diagnosticId),
      payload: { summary: 'Diagnostic visit completed', drivability: 'drivable', disposition: 'diagnose_only' }
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    const diag = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'diagnostic' } });
    diagnosticId = JSON.parse(diag.body).actor.id;
  });

  afterAll(async () => {
    await pool.query(`update routing_policies set active=false where policy_key='diagnostic_fee_default'`);
    await pool.end();
  });

  it('charges no fee and creates no payment_intent when no policy is active', async () => {
    await setDiagnosticFeeActive(false);
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;
    const { demandId, caseId } = await openCaseWithAcceptedDiagnostic(customerId);

    const findingRes = await submitFinding(demandId);
    expect(findingRes.statusCode).toBe(201);

    const payments = await pool.query(`select 1 from payment_intents where case_id=$1 and metadata->>'kind'='diagnostic_fee'`, [caseId]);
    expect(payments.rowCount).toBe(0);
  });

  it('charges the standalone fee when the customer has no membership', async () => {
    await setDiagnosticFeeActive(true, 2500);
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;
    const { demandId, caseId } = await openCaseWithAcceptedDiagnostic(customerId);

    const findingRes = await submitFinding(demandId);
    expect(findingRes.statusCode).toBe(201);

    const payment = await pool.query(`select * from payment_intents where case_id=$1 and metadata->>'kind'='diagnostic_fee'`, [caseId]);
    expect(payment.rowCount).toBe(1);
    expect(Number(payment.rows[0].amount)).toBe(25);
    expect(payment.rows[0].currency).toBe('USD');
  });

  it('waives the fee out of a paid membership quota, then charges once the quota is used up', async () => {
    await setDiagnosticFeeActive(true, 2500);
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;

    const enroll = await app.inject({ method: 'POST', url: `/api/admin/customers/${customerId}/membership`, headers: adminHeaders(), payload: { planKey: 'plus' } });
    expect(enroll.statusCode).toBe(201);

    const membershipView = await app.inject({ method: 'GET', url: '/api/customers/me/membership', headers: actorHeaders('customer', customerId) });
    expect(membershipView.statusCode).toBe(200);
    expect(JSON.parse(membershipView.body).membership).toMatchObject({ planKey: 'plus', includedDiagnosticsPerPeriod: 2, diagnosticsUsedThisPeriod: 0 });

    // 'plus' includes 2 diagnostics per period -- the first two visits should be covered.
    for (let i = 0; i < 2; i++) {
      const { demandId, caseId } = await openCaseWithAcceptedDiagnostic(customerId);
      const findingRes = await submitFinding(demandId);
      expect(findingRes.statusCode).toBe(201);
      const payment = await pool.query(`select 1 from payment_intents where case_id=$1 and metadata->>'kind'='diagnostic_fee'`, [caseId]);
      expect(payment.rowCount).toBe(0);
    }

    const afterQuota = await app.inject({ method: 'GET', url: '/api/customers/me/membership', headers: actorHeaders('customer', customerId) });
    expect(JSON.parse(afterQuota.body).membership.diagnosticsRemainingThisPeriod).toBe(0);

    // Third visit this period exceeds the included quota -- the standalone fee applies.
    const { demandId, caseId } = await openCaseWithAcceptedDiagnostic(customerId);
    const findingRes = await submitFinding(demandId);
    expect(findingRes.statusCode).toBe(201);
    const payment = await pool.query(`select 1 from payment_intents where case_id=$1 and metadata->>'kind'='diagnostic_fee'`, [caseId]);
    expect(payment.rowCount).toBe(1);
  });

  it('gates loaner tier by membership plan', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;
    const fleetPartner = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'fleet' } });
    const fleetActorId = JSON.parse(fleetPartner.body).actor.id;

    const luxuryResource = await app.inject({
      method: 'POST', url: '/api/admin/mobility/resources', headers: adminHeaders(),
      payload: { actorId: fleetActorId, resourceType: 'loaner', label: 'Luxury sedan', attributes: { tier: 'luxury' } }
    });
    const luxuryResourceId = JSON.parse(luxuryResource.body).resource.id;
    const economyResource = await app.inject({
      method: 'POST', url: '/api/admin/mobility/resources', headers: adminHeaders(),
      payload: { actorId: fleetActorId, resourceType: 'loaner', label: 'Economy sedan', attributes: { tier: 'economy' } }
    });
    const economyResourceId = JSON.parse(economyResource.body).resource.id;

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal', attributes: { requiresDiagnostic: false } }
    });
    const caseId = JSON.parse(demandRes.body).case.id;
    const allocationRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/mobility`, headers: actorHeaders('customer', customerId),
      payload: { allocationType: 'loaner' }
    });
    const allocationId = JSON.parse(allocationRes.body).allocation.id;

    // No membership at all defaults to the free tier (economy-only).
    const luxuryDenied = await app.inject({
      method: 'POST', url: `/api/admin/mobility/${allocationId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: fleetActorId, resourceId: luxuryResourceId }
    });
    expect(luxuryDenied.statusCode).toBe(409);
    expect(JSON.parse(luxuryDenied.body).error).toBe('loaner_tier_not_permitted');

    const economyAllowed = await app.inject({
      method: 'POST', url: `/api/admin/mobility/${allocationId}/assign`, headers: adminHeaders(),
      payload: { providerActorId: fleetActorId, resourceId: economyResourceId }
    });
    expect(economyAllowed.statusCode).toBe(200);
    expect(JSON.parse(economyAllowed.body).allocation.resource_id).toBe(economyResourceId);
  });
});
