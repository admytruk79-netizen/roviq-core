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

describe('payments and settlement end-to-end lifecycle', () => {
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

    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    strangerCustomerId = JSON.parse(stranger.body).actor.id;

    const partner = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'shop', domain: 'maintenance' } });
    partnerActorId = JSON.parse(partner.body).actor.id;

    const strangerPartner = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'shop', domain: 'maintenance' } });
    strangerPartnerId = JSON.parse(strangerPartner.body).actor.id;

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    caseId = JSON.parse(demandRes.body).case.id;

    const revisionRes = await app.inject({
      method: 'POST', url: `/api/admin/maintenance/cases/${caseId}/service-plan/revisions`, headers: adminHeaders(),
      payload: { changeReason: 'Diagnosed worn brake pads', estimatedTotalMinor: 30000, currency: 'usd', tasks: [{ taskType: 'repair', title: 'Replace brake pads', estimatedAmountMinor: 30000 }] }
    });
    const approvalId = JSON.parse(revisionRes.body).plan.pendingApproval.id;
    await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/approvals/${approvalId}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'approved' }
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('completes payment capture, refunds and payout settlement with enforced access and a consistent ledger', async () => {
    const missingCaseRes = await app.inject({
      method: 'POST', url: '/api/admin/payments', headers: adminHeaders(),
      payload: { caseId: '00000000-0000-0000-0000-000000000000', amount: 300 }
    });
    expect(missingCaseRes.statusCode).toBe(404);
    expect(JSON.parse(missingCaseRes.body).error).toBe('case_not_found');

    const payment1Res = await app.inject({
      method: 'POST', url: '/api/admin/payments', headers: adminHeaders(),
      payload: { caseId, amount: 300, currency: 'USD', description: 'Brake pad replacement' }
    });
    expect(payment1Res.statusCode).toBe(201);
    const payment1 = JSON.parse(payment1Res.body).payment;
    expect(payment1.state).toBe('created');

    // Access control: only the owning customer (or admin) can see this case's payments.
    const forbiddenPaymentsRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/payments`, headers: actorHeaders('customer', strangerCustomerId) });
    expect(forbiddenPaymentsRes.statusCode).toBe(403);
    const unrelatedPartnerPaymentsRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/payments`, headers: actorHeaders('partner', strangerPartnerId) });
    expect(unrelatedPartnerPaymentsRes.statusCode).toBe(403);
    const ownerPaymentsRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/payments`, headers: actorHeaders('customer', customerActorId) });
    expect(ownerPaymentsRes.statusCode).toBe(200);
    expect(JSON.parse(ownerPaymentsRes.body).payments.some((p: { id: string }) => p.id === payment1.id)).toBe(true);

    const captureRes = await app.inject({ method: 'POST', url: `/api/admin/payments/${payment1.id}/state`, headers: adminHeaders(), payload: { state: 'captured' } });
    expect(captureRes.statusCode).toBe(200);
    expect(JSON.parse(captureRes.body).payment.state).toBe('captured');

    // A captured payment has no further valid transitions.
    const invalidTransitionRes = await app.inject({ method: 'POST', url: `/api/admin/payments/${payment1.id}/state`, headers: adminHeaders(), payload: { state: 'authorized' } });
    expect(invalidTransitionRes.statusCode).toBe(409);
    expect(JSON.parse(invalidTransitionRes.body).error).toBe('invalid_payment_transition');

    const missingPaymentRes = await app.inject({ method: 'POST', url: '/api/admin/payments/00000000-0000-0000-0000-000000000000/state', headers: adminHeaders(), payload: { state: 'captured' } });
    expect(missingPaymentRes.statusCode).toBe(404);

    // A second payment intent, left uncaptured, to exercise refund_not_allowed.
    const payment2Res = await app.inject({
      method: 'POST', url: '/api/admin/payments', headers: adminHeaders(),
      payload: { caseId, amount: 150, currency: 'USD', description: 'Additional labor' }
    });
    const payment2 = JSON.parse(payment2Res.body).payment;

    const refundNotAllowedRes = await app.inject({ method: 'POST', url: `/api/admin/payments/${payment2.id}/refunds`, headers: adminHeaders(), payload: { amount: 50 } });
    expect(refundNotAllowedRes.statusCode).toBe(409);
    expect(JSON.parse(refundNotAllowedRes.body).error).toBe('refund_not_allowed');

    const overRefundRes = await app.inject({ method: 'POST', url: `/api/admin/payments/${payment1.id}/refunds`, headers: adminHeaders(), payload: { amount: 400 } });
    expect(overRefundRes.statusCode).toBe(409);
    expect(JSON.parse(overRefundRes.body).error).toBe('invalid_refund_amount');

    const partialRefundRes = await app.inject({ method: 'POST', url: `/api/admin/payments/${payment1.id}/refunds`, headers: adminHeaders(), payload: { amount: 100 } });
    expect(partialRefundRes.statusCode).toBe(200);
    expect(JSON.parse(partialRefundRes.body).payment.state).toBe('partially_refunded');

    const fullRefundRes = await app.inject({ method: 'POST', url: `/api/admin/payments/${payment1.id}/refunds`, headers: adminHeaders(), payload: { amount: 200 } });
    expect(fullRefundRes.statusCode).toBe(200);
    expect(JSON.parse(fullRefundRes.body).payment.state).toBe('refunded');

    const missingRefundRes = await app.inject({ method: 'POST', url: '/api/admin/payments/00000000-0000-0000-0000-000000000000/refunds', headers: adminHeaders(), payload: { amount: 10 } });
    expect(missingRefundRes.statusCode).toBe(404);

    // Capture the second payment so it can be settled out to the partner.
    await app.inject({ method: 'POST', url: `/api/admin/payments/${payment2.id}/state`, headers: adminHeaders(), payload: { state: 'captured' } });

    const payoutRes = await app.inject({
      method: 'POST', url: '/api/admin/payouts', headers: adminHeaders(),
      payload: { caseId, counterpartyActorId: partnerActorId, paymentIntentId: payment2.id, amount: 100, currency: 'USD' }
    });
    expect(payoutRes.statusCode).toBe(201);
    const payout = JSON.parse(payoutRes.body).payout;
    expect(payout.state).toBe('pending');

    // Skipping straight from 'pending' to 'paid' is an invalid transition.
    const invalidPayoutSkipRes = await app.inject({ method: 'POST', url: `/api/admin/payouts/${payout.id}/state`, headers: adminHeaders(), payload: { state: 'paid' } });
    expect(invalidPayoutSkipRes.statusCode).toBe(409);
    expect(JSON.parse(invalidPayoutSkipRes.body).error).toBe('invalid_payout_transition');

    for (const state of ['approved', 'processing', 'paid']) {
      const res = await app.inject({ method: 'POST', url: `/api/admin/payouts/${payout.id}/state`, headers: adminHeaders(), payload: { state } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).payout.state).toBe(state);
    }

    const missingPayoutRes = await app.inject({ method: 'POST', url: '/api/admin/payouts/00000000-0000-0000-0000-000000000000/state', headers: adminHeaders(), payload: { state: 'approved' } });
    expect(missingPayoutRes.statusCode).toBe(404);

    // The partner sees their own paid-out payout; an unrelated partner does not.
    const myPayoutsRes = await app.inject({ method: 'GET', url: '/api/partners/me/payouts', headers: actorHeaders('partner', partnerActorId) });
    expect(myPayoutsRes.statusCode).toBe(200);
    expect(JSON.parse(myPayoutsRes.body).payouts.some((p: { id: string }) => p.id === payout.id)).toBe(true);
    const strangerPayoutsRes = await app.inject({ method: 'GET', url: '/api/partners/me/payouts', headers: actorHeaders('partner', strangerPartnerId) });
    expect(JSON.parse(strangerPayoutsRes.body).payouts.some((p: { id: string }) => p.id === payout.id)).toBe(false);

    // The financials rollup reflects a consistent ledger: two captures, two refunds, one payout.
    const financialsRes = await app.inject({ method: 'GET', url: `/api/admin/cases/${caseId}/financials`, headers: adminHeaders() });
    expect(financialsRes.statusCode).toBe(200);
    const financials = JSON.parse(financialsRes.body);
    expect(financials.payments.length).toBe(2);
    expect(financials.payouts.length).toBe(1);
    const ledgerTypes = financials.ledger.map((l: { entry_type: string }) => l.entry_type);
    expect(ledgerTypes.filter((t: string) => t === 'payment_capture').length).toBe(2);
    expect(ledgerTypes.filter((t: string) => t === 'refund').length).toBe(2);
    expect(ledgerTypes.filter((t: string) => t === 'provider_payout').length).toBe(1);

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const timelineEvents = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(timelineEvents).toEqual(expect.arrayContaining([
      'PAYMENT_INTENT_CREATED', 'PAYMENT_CAPTURED', 'PAYMENT_REFUNDED',
      'PAYOUT_CREATED', 'PAYOUT_APPROVED', 'PAYOUT_PROCESSING', 'PAYOUT_PAID'
    ]));

    // What ROVIQ pays the partner (partner payable) is never part of the customer's own case
    // narrative -- only admins see PAYOUT_* events on the case timeline.
    const customerTimelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: actorHeaders('customer', customerActorId) });
    expect(customerTimelineRes.statusCode).toBe(200);
    const customerTimelineEvents = JSON.parse(customerTimelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(customerTimelineEvents.some((t: string) => t.startsWith('PAYOUT_'))).toBe(false);
    expect(customerTimelineEvents).toEqual(expect.arrayContaining(['PAYMENT_INTENT_CREATED', 'PAYMENT_CAPTURED']));
  });
});
