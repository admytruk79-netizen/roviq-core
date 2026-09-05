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

describe('case metrics analytics', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let diagnosticActorId: string;

  beforeAll(async () => {
    app = await buildApp();
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
    const diagnostic = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'diagnostic' } });
    diagnosticActorId = JSON.parse(diagnostic.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createCase(): Promise<string> {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    return JSON.parse(demandRes.body).case.id as string;
  }

  async function getMetrics(from: string, to: string) {
    const res = await app.inject({ method: 'GET', url: `/api/admin/analytics/case-metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  it('is admin-only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/analytics/case-metrics', headers: actorHeaders('customer', customerActorId) });
    expect(res.statusCode).toBe(403);
  });

  it('computes every documented metric correctly from known, deliberately constructed data, isolated by a tight time window', async () => {
    // A shared e2e run puts many other tests' rows in the same tables. Aggregates here are
    // global (no case_id filter -- that's the point of a platform-wide report), so isolation
    // comes from a from/to window scoped tightly around just this test's own inserts, not from
    // the tables being empty.
    const windowStart = new Date();

    const caseA = await createCase();
    const caseB = await createCase();
    const caseC = await createCase();

    // caseDuration: exactly 60 minutes. completed_at is left at "now" (within the window that
    // follows); only created_at is backdated, since the metric filters on completed_at.
    await pool.query(
      `update service_cases set state='completed', created_at=now()-interval '60 minutes', completed_at=now() where id=$1`,
      [caseA]
    );

    // diagnosticConversion: 2 findings, 1 converts (disposition beyond diagnose_only, case not cancelled).
    await pool.query(
      `insert into diagnostic_findings(demand_id,case_id,diagnostic_actor_id,summary,drivability,disposition)
       select demand_id,$1,$2,'converts','unknown','diagnose_and_fix'::text from service_cases where id=$1`,
      [caseA, diagnosticActorId]
    );
    await pool.query(
      `insert into diagnostic_findings(demand_id,case_id,diagnostic_actor_id,summary,drivability,disposition)
       select demand_id,$1,$2,'does not convert','unknown','diagnose_only'::text from service_cases where id=$1`,
      [caseB, diagnosticActorId]
    );

    // fieldRepairEligibility/Success/towAvoidance share 3 decisions:
    // D1 field_repair+completed (started) -> eligible, succeeded, tow-avoided.
    // D2 tow_required (not started)       -> a tow-avoidance candidate that was NOT avoided.
    // D3 dispatch_field_technician+escalated (started) -> counts in success denominator, not eligible, not a tow-avoidance candidate.
    await pool.query(
      `insert into field_service_decisions(case_id,action,status,summary,started_at,customer_authorization_required,customer_authorized_at,created_at)
       values($1,'field_repair','completed','on-site fix',now(),true,now()+interval '10 minutes',now())`,
      [caseA]
    );
    await pool.query(
      `insert into field_service_decisions(case_id,action,status,summary,created_at)
       values($1,'tow_required','proposed','needs tow',now())`,
      [caseB]
    );
    await pool.query(
      `insert into field_service_decisions(case_id,action,status,summary,started_at,created_at)
       values($1,'dispatch_field_technician','escalated','specialist needed',now(),now())`,
      [caseC]
    );

    // handoffFailure: 2 transport dispatches (1 failed), 2 parts orders (1 cancelled).
    await pool.query(
      `insert into transport_dispatches(case_id,transport_type,status,pickup_location,dropoff_location)
       values($1,'tow','delivered','{}'::jsonb,'{}'::jsonb),($1,'tow','failed','{}'::jsonb,'{}'::jsonb)`,
      [caseA]
    );
    await pool.query(
      `insert into parts_orders(case_id,status) values($1,'delivered'),($1,'cancelled')`,
      [caseA]
    );

    // exceptionRate: 1 exception across the 3 cases created in this window.
    await pool.query(`insert into case_exceptions(case_id,exception_code,summary) values($1,'test_exception','synthetic')`,[caseB]);

    // customerResponseTime: an approval decided 20 minutes after request, a quote decided 30
    // minutes after being presented. D1 above already covers the field-service channel at 10
    // minutes via customer_authorized_at.
    await pool.query(
      `insert into case_approvals(case_id,approval_type,state,created_at,decided_at) values($1,'quote','approved',now(),now()+interval '20 minutes')`,
      [caseC]
    );
    const plan = await pool.query('select id from service_plans where case_id=$1',[caseC]);
    await pool.query(
      `insert into service_quotes(case_id,service_plan_id,revision,status,presented_at,created_at,updated_at)
       values($1,$2,1,'accepted',now(),now(),now()+interval '30 minutes')`,
      [caseC, plan.rows[0].id]
    );

    // contributionMargin: a quote with 4 lines exercising every case --
    // gross keeps its full amount, net-with-cost keeps the difference, net-without-cost is
    // excluded (not assumed), pass_through contributes nothing.
    const planA = await pool.query('select id from service_plans where case_id=$1',[caseA]);
    const marginQuote = await pool.query(
      `insert into service_quotes(case_id,service_plan_id,revision,status) values($1,$2,1,'draft') returning id`,
      [caseA, planA.rows[0].id]
    );
    await pool.query(
      `insert into service_quote_lines(quote_id,line_type,description,quantity,unit_amount_minor,line_amount_minor,revenue_recognition,merchant_cost_minor)
       values
         ($1,'coordination','Case fee',1,3900,3900,'gross',null),
         ($1,'part','Brake pad',1,3000,3000,'net',2000),
         ($1,'diagnostic','Visit fee',1,5000,5000,'net',null),
         ($1,'labor','Labor',1,8000,8000,'pass_through',null)`,
      [marginQuote.rows[0].id]
    );

    const windowEnd = new Date(Date.now() + 5 * 60 * 1000);
    const metrics = await getMetrics(windowStart.toISOString(), windowEnd.toISOString());

    expect(metrics.caseDuration.sampleSize).toBe(1);
    expect(metrics.caseDuration.avgMinutes).toBeCloseTo(60, 0);
    expect(metrics.caseDuration.medianMinutes).toBeCloseTo(60, 0);

    expect(metrics.diagnosticConversion).toEqual({ rate: 0.5, converted: 1, total: 2 });
    expect(metrics.fieldRepairEligibility).toEqual({ rate: 1 / 3, eligible: 1, total: 3 });
    expect(metrics.fieldRepairSuccess).toEqual({ rate: 0.5, succeeded: 1, started: 2 });
    expect(metrics.towAvoidance).toEqual({ rate: 0.5, avoided: 1, candidates: 2 });
    expect(metrics.handoffFailure).toEqual({ rate: 0.5, failed: 2, total: 4 });
    // caseA's created_at was deliberately backdated above (for the duration metric, which
    // filters on completed_at instead), so it falls outside this window on created_at -- only
    // caseB and caseC count here.
    expect(metrics.exceptionRate).toEqual({ rate: 0.5, exceptions: 1, cases: 2 });

    expect(metrics.customerResponseTimeMinutes.fieldServiceCount).toBe(1);
    expect(metrics.customerResponseTimeMinutes.fieldServiceMinutes).toBeCloseTo(10, 0);
    expect(metrics.customerResponseTimeMinutes.approvalCount).toBe(1);
    expect(metrics.customerResponseTimeMinutes.approvalMinutes).toBeCloseTo(20, 0);
    expect(metrics.customerResponseTimeMinutes.quoteCount).toBe(1);
    expect(metrics.customerResponseTimeMinutes.quoteMinutes).toBeCloseTo(30, 0);
    expect(metrics.customerResponseTimeMinutes.blendedCount).toBe(3);
    expect(metrics.customerResponseTimeMinutes.blendedMinutes).toBeCloseTo(20, 0); // (10+20+30)/3

    // Contribution margin: 3900 (gross, full) + 1000 (net, 3000-2000) + 0 (net missing cost,
    // excluded not assumed) + 0 (pass_through, by definition) = 4900. The missing-cost net line
    // is disclosed via netLinesMissingCost/complete rather than silently folded into the total.
    expect(metrics.contributionMargin).toEqual({ marginMinor: 4900, netLinesMissingCost: 1, netLinesTotal: 2, complete: false });
  });

  it('reports null rates (not zero, not a crash) for a window with no matching data', async () => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const laterStill = new Date(farFuture.getTime() + 60 * 1000);
    const metrics = await getMetrics(farFuture.toISOString(), laterStill.toISOString());
    expect(metrics.caseDuration.sampleSize).toBe(0);
    expect(metrics.caseDuration.avgMinutes).toBeNull();
    expect(metrics.diagnosticConversion).toEqual({ rate: null, converted: 0, total: 0 });
    expect(metrics.fieldRepairEligibility).toEqual({ rate: null, eligible: 0, total: 0 });
    expect(metrics.exceptionRate).toEqual({ rate: null, exceptions: 0, cases: 0 });
    expect(metrics.contributionMargin).toEqual({ marginMinor: 0, netLinesMissingCost: 0, netLinesTotal: 0, complete: true });
  });
});
