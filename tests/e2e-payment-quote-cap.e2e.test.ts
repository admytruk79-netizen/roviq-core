import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// ROVIQ never asks a customer for more than they approved: all live payments on a case together
// stay within the approved quote. Less (a deposit) is allowed; failed or cancelled payments don't count.

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };

describe('payments are capped at the customer-approved quote', () => {
  let app: FastifyInstance;
  let caseId: string;

  beforeAll(async () => {
    app = await buildApp();
    const customerId = (await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType: 'customer' } })).json().actor.id;
    const domain = await pool.query(`select id from domains where code='maintenance' limit 1`);
    caseId = (await pool.query(`insert into service_cases(domain_id,case_type,state,customer_actor_id) values($1,'maintenance','payment_pending',$2) returning id`, [domain.rows[0].id, customerId])).rows[0].id;
    await pool.query('insert into service_plans(case_id) values($1)', [caseId]);
    const revision = await app.inject({
      method: 'POST', url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`, headers: admin,
      payload: { changeReason: 'Brake pads', estimatedTotalMinor: 30000, currency: 'usd', tasks: [{ taskType: 'repair', title: 'Replace brake pads', estimatedAmountMinor: 30000 }] }
    });
    expect(revision.statusCode).toBeLessThan(300);
    const approvalId = revision.json().plan.pendingApproval.id;
    const decided = await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${approvalId}/decision`, headers: { 'x-roviq-role': 'customer', 'x-roviq-actor-id': customerId }, payload: { decision: 'approved' } });
    expect(decided.statusCode).toBeLessThan(300);
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  const pay = (amount: number, currency = 'USD') => app.inject({ method: 'POST', url: '/api/admin/payments', headers: admin, payload: { caseId, amount, currency } });

  it('refuses more than approved, allows less, and counts every live payment on the case', async () => {
    const over = await pay(300.01);
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('payment_exceeds_approved_quote');

    const deposit = await pay(200);
    expect(deposit.statusCode).toBe(201);
    expect((await pay(100.01)).json().error).toBe('payment_exceeds_approved_quote');

    // A cancelled request frees its amount again.
    await pool.query(`update payment_intents set state='cancelled' where id=$1`, [deposit.json().payment.id]);
    const full = await pay(300);
    expect(full.statusCode).toBe(201);
    expect((await pay(0.01)).statusCode).toBe(409);

    // So does a refund: after capturing 300 and refunding 50, 50 may be requested again.
    const paymentId = full.json().payment.id;
    expect((await app.inject({ method: 'POST', url: `/api/admin/payments/${paymentId}/state`, headers: admin, payload: { state: 'captured' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/payments/${paymentId}/refunds`, headers: admin, payload: { amount: 50 } })).statusCode).toBe(200);
    expect((await pay(50.01)).json().error).toBe('payment_exceeds_approved_quote');
    expect((await pay(50)).statusCode).toBe(201);
  });

  it('refuses a currency other than the quote’s', async () => {
    const res = await pay(1, 'EUR');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('payment_currency_differs_from_quote');
  });
});
