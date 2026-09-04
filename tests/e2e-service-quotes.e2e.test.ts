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

describe('service quotes (case-level quote creation and merchant-of-record allocation)', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let shopActorId: string;
  let partsVendorActorId: string;

  beforeAll(async () => {
    app = await buildApp();
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;
    const shop = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'shop', domain: 'maintenance' } });
    shopActorId = JSON.parse(shop.body).actor.id;
    const vendor = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    partsVendorActorId = JSON.parse(vendor.body).actor.id;
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

  it('applies documented merchant-of-record defaults per line type and computes totals server-side', async () => {
    const caseId = await createCase();
    const createRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: adminHeaders(),
      payload: {
        currency: 'usd',
        lines: [
          // Labor: no revenueRecognition specified -- shop keeps 100% (pass_through), no ROVIQ cut.
          { lineType: 'labor', description: 'Brake pad replacement labor', quantity: 1, unitAmountMinor: 12000, merchantActorId: shopActorId },
          // Parts: no revenueRecognition specified -- ROVIQ's margin is the vendor markup (net).
          { lineType: 'part', description: 'Front brake pads', quantity: 2, unitAmountMinor: 3000, merchantActorId: partsVendorActorId },
          // Coordination fee: ROVIQ's own revenue, no counterparty, no merchant required.
          { lineType: 'coordination', description: 'Case coordination fee', unitAmountMinor: 3900 },
          // Tax: merchant-exempt line type -- no merchant required even though its default is pass_through.
          { lineType: 'tax', description: 'Sales tax', unitAmountMinor: 1836 }
        ]
      }
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.quote.status).toBe('draft');
    expect(created.quote.revision).toBe(1);
    // subtotal = 12000 + 6000 (2x3000) + 3900 = 21900; tax = 1836; total = 23736
    // bigint columns come back from pg as strings, hence Number(...) here.
    expect(Number(created.quote.subtotal_minor)).toBe(21900);
    expect(Number(created.quote.tax_minor)).toBe(1836);
    expect(Number(created.quote.total_minor)).toBe(23736);

    const lines = created.lines as Array<{ line_type: string; revenue_recognition: string; merchant_actor_id: string | null; line_amount_minor: string }>;
    const labor = lines.find((l) => l.line_type === 'labor')!;
    expect(labor.revenue_recognition).toBe('pass_through');
    expect(labor.merchant_actor_id).toBe(shopActorId);
    expect(Number(labor.line_amount_minor)).toBe(12000);

    const part = lines.find((l) => l.line_type === 'part')!;
    expect(part.revenue_recognition).toBe('net');
    expect(part.merchant_actor_id).toBe(partsVendorActorId);
    expect(Number(part.line_amount_minor)).toBe(6000);

    const coordination = lines.find((l) => l.line_type === 'coordination')!;
    expect(coordination.revenue_recognition).toBe('gross');
    expect(coordination.merchant_actor_id).toBeNull();

    const tax = lines.find((l) => l.line_type === 'tax')!;
    expect(tax.revenue_recognition).toBe('pass_through');
    expect(tax.merchant_actor_id).toBeNull();
  });

  it('rejects a net/pass_through line with no merchant of record, but allows an explicit gross override with no merchant', async () => {
    const caseId = await createCase();

    const missingMerchantRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: adminHeaders(),
      payload: { lines: [{ lineType: 'part', description: 'Unattributed part', unitAmountMinor: 5000 }] }
    });
    expect(missingMerchantRes.statusCode).toBe(400);
    expect(JSON.parse(missingMerchantRes.body).error).toBe('merchant_required_for_recognized_revenue');

    // A caller can still override the default recognition explicitly per line -- here declaring a
    // labor line as ROVIQ's own gross revenue (e.g. a directly-employed technician), which needs no
    // merchant despite line type 'labor' defaulting to pass_through.
    const overrideRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: adminHeaders(),
      payload: { lines: [{ lineType: 'labor', description: 'ROVIQ-direct labor', unitAmountMinor: 5000, revenueRecognition: 'gross' }] }
    });
    expect(overrideRes.statusCode).toBe(201);
    expect(JSON.parse(overrideRes.body).lines[0].revenue_recognition).toBe('gross');
  });

  it('supersedes the prior open quote on a new revision, and only the current quote can be decided', async () => {
    const caseId = await createCase();
    const quote1Res = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: adminHeaders(),
      payload: { lines: [{ lineType: 'coordination', description: 'Preliminary case fee', unitAmountMinor: 3900 }] }
    });
    const quote1 = JSON.parse(quote1Res.body).quote;
    const present1Res = await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes/${quote1.id}/present`, headers: adminHeaders() });
    expect(present1Res.statusCode).toBe(200);

    // A technician confirms the job on arrival and the terms change -- a new quote replaces the
    // preliminary one (the same preliminary/final distinction the business plan describes, achieved
    // through revision-supersede rather than a separate quote_type column).
    const quote2Res = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: adminHeaders(),
      payload: { lines: [{ lineType: 'coordination', description: 'Confirmed case fee', unitAmountMinor: 3900 }] }
    });
    expect(quote2Res.statusCode).toBe(201);
    const quote2 = JSON.parse(quote2Res.body).quote;
    expect(quote2.revision).toBe(2);

    const listRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/quotes`, headers: adminHeaders() });
    const quotes = JSON.parse(listRes.body).quotes as Array<{ id: string; status: string }>;
    expect(quotes.find((q) => q.id === quote1.id)?.status).toBe('superseded');
    expect(quotes.find((q) => q.id === quote2.id)?.status).toBe('draft');

    // The superseded quote can no longer be decided, even though it was validly presented earlier.
    const staleDecisionRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes/${quote1.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'accepted' }
    });
    expect(staleDecisionRes.statusCode).toBe(409);
    expect(JSON.parse(staleDecisionRes.body).error).toBe('quote_not_awaiting_decision');

    // The current quote, once presented, can be accepted by the case's own customer.
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes/${quote2.id}/present`, headers: adminHeaders() });
    const decisionRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes/${quote2.id}/decision`, headers: actorHeaders('customer', customerActorId),
      payload: { decision: 'accepted' }
    });
    expect(decisionRes.statusCode).toBe(200);
    expect(JSON.parse(decisionRes.body).quote.status).toBe('accepted');
  });

  it('rejects a decision from a customer who is not this case\'s own customer', async () => {
    const caseId = await createCase();
    const quoteRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: adminHeaders(),
      payload: { lines: [{ lineType: 'coordination', description: 'Case fee', unitAmountMinor: 3900 }] }
    });
    const quote = JSON.parse(quoteRes.body).quote;
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes/${quote.id}/present`, headers: adminHeaders() });

    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const strangerId = JSON.parse(stranger.body).actor.id;
    const forbiddenRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes/${quote.id}/decision`, headers: actorHeaders('customer', strangerId),
      payload: { decision: 'accepted' }
    });
    expect(forbiddenRes.statusCode).toBe(403);
  });

  it('rejects quote creation from a partner with no accepted offer on the case, and allows one with an accepted offer', async () => {
    const caseId = await createCase();

    const unrelatedPartner = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'shop', domain: 'maintenance' } });
    const unrelatedPartnerId = JSON.parse(unrelatedPartner.body).actor.id;
    const forbiddenRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: actorHeaders('partner', unrelatedPartnerId),
      payload: { lines: [{ lineType: 'coordination', description: 'Case fee', unitAmountMinor: 3900 }] }
    });
    expect(forbiddenRes.statusCode).toBe(403);

    const demandId = (await pool.query('select demand_id from service_cases where id=$1', [caseId])).rows[0].demand_id;
    await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,outcome,offered_at,responded_at) values($1,$2,$3,'accepted',now(),now())`,
      [demandId, caseId, shopActorId]
    );
    const allowedRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/quotes`, headers: actorHeaders('partner', shopActorId),
      payload: { lines: [{ lineType: 'labor', description: 'Labor', unitAmountMinor: 5000, merchantActorId: shopActorId }] }
    });
    expect(allowedRes.statusCode).toBe(201);
  });
});
