import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { applyShopCheckoutSession } from '../src/services/shop-customer-links.js';

// A Shop OS shop running its own walk-in customer end to end: estimate link, the customer's
// approve/decline, parts on a walk-in job, completion that settles the books, counter payments,
// and the daily takings view. No ROVIQ case is involved anywhere.

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };

describe('Shop OS walk-in estimate, payment and books', () => {
  let app: FastifyInstance;
  let shop: Record<string, string>;
  let other: Record<string, string>;
  let locationId: string;
  let roId: string;
  let lines: Record<string, string>;
  let token: string;

  async function onboard(name: string) {
    const email = `${randomUUID()}@shop.test`; const password = 'Walk-in-shop-2026!';
    const res = await app.inject({ method: 'POST', url: '/api/admin/business-onboarding', headers: admin, payload: {
      requestId: randomUUID(), role: 'partner', businessName: name, operatorName: 'Owner', email, password,
      location: { name, address: '1 Main St', city: 'Toronto', region: 'ON', countryCode: 'CA' } } });
    expect(res.statusCode).toBe(201);
    // Ops has verified this shop's repair licence (Ops → Eligibility); without it no repair work can be approved.
    await pool.query(`insert into business_service_authorizations(organization_id,service,state,valid_from,expires_at,evidence_reference,verified_at,review_reason)
      values($1,'repair','verified',now()-interval '1 day',now()+interval '1 year','Test licence',now(),'Verified for walk-in tests')`, [res.json().business.organizationId]);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return { headers: { authorization: `Bearer ${login.json().accessToken}` }, locationId: res.json().business.locationId as string };
  }
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers = shop) => app.inject({ method, url, headers, ...(payload ? { payload: payload as object } : {}) });
  const publicView = (t = token) => app.inject({ method: 'GET', url: `/api/public/shop-estimates/${t}` });

  beforeAll(async () => {
    app = await buildApp();
    const a = await onboard('Walk-in Test Garage'); shop = a.headers; locationId = a.locationId;
    other = (await onboard('Other Garage')).headers;
    const intake = await api('POST', '/api/shop-os/local-intake', { locationId, displayName: 'Jordan Lee', phone: '416-555-0142', vehicle: { make: 'Honda', model: 'CR-V', modelYear: 2019, licensePlate: 'CBDX 214' } });
    expect(intake.statusCode).toBe(201);
    const ro = await api('POST', '/api/shop-os/repair-orders', { locationId, shopCustomerId: intake.json().customer.id, shopVehicleId: intake.json().vehicle.id, customerConcern: 'Grinding from front brakes', odometer: 84210 });
    expect(ro.statusCode).toBe(201);
    roId = ro.json().repairOrder.id;
    lines = {};
    for (const [key, line] of Object.entries({
      labor: { lineType: 'labor', description: 'Front pads and rotors', quantity: 2, unitPrice: 145, unitCost: 42 },
      part: { lineType: 'part', description: 'Front rotors (pair)', quantity: 1, unitPrice: 189, unitCost: 110 },
      extra: { lineType: 'sublet', description: 'Wheel alignment', quantity: 1, unitPrice: 99, unitCost: 60 }
    })) lines[key] = (await api('POST', `/api/shop-os/repair-orders/${roId}/lines`, line)).json().line.id;
    expect((await api('PATCH', `/api/shop-os/repair-orders/${roId}`, { action: 'submit_estimate' })).statusCode).toBe(200);
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  it('sends the walk-in customer a private estimate link that shows prices but no internal data', async () => {
    const link = await api('POST', `/api/shop-os/repair-orders/${roId}/customer-link`);
    expect(link.statusCode).toBe(201);
    token = link.json().url.split('/estimate/')[1];
    expect(token.length).toBeGreaterThan(20);
    const view = await publicView();
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body).toMatchObject({ shop: { name: 'Walk-in Test Garage' }, customerName: 'Jordan', vehicle: '2019 Honda CR-V', canDecide: true, canPay: false, totals: { estimate: 578, approved: 0 } });
    expect(JSON.stringify(body)).not.toMatch(/unit_cost|unitCost|416-555|internal/);
    expect((await app.inject({ method: 'GET', url: '/api/public/shop-estimates/not-a-real-token-at-all-xyz' })).statusCode).toBe(404);
    // Another shop cannot create links or read payments for this order.
    expect([403, 404]).toContain((await api('POST', `/api/shop-os/repair-orders/${roId}/customer-link`, undefined, other)).statusCode);
  });

  it('lets the customer approve and decline each line, once', async () => {
    const decide = (decisions: unknown) => app.inject({ method: 'POST', url: `/api/public/shop-estimates/${token}/decision`, payload: { decisions } });
    expect((await decide([{ lineId: lines.labor, decision: 'approved' }])).statusCode).toBe(400);
    const res = await decide([{ lineId: lines.labor, decision: 'approved' }, { lineId: lines.part, decision: 'approved' }, { lineId: lines.extra, decision: 'declined' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'approved', approvedAmount: 479 });
    expect((await decide([{ lineId: lines.labor, decision: 'declined' }, { lineId: lines.part, decision: 'declined' }, { lineId: lines.extra, decision: 'declined' }])).statusCode).toBe(409);
    const ro = (await api('GET', `/api/shop-os/repair-orders/${roId}`)).json();
    expect(ro.repairOrder).toMatchObject({ status: 'approved' });
    expect(Object.fromEntries(ro.lines.map((l: { id: string; approval_status: string }) => [l.id, l.approval_status]))).toEqual({ [lines.labor]: 'approved', [lines.part]: 'approved', [lines.extra]: 'declined' });
  });

  it('tracks parts on a walk-in job, then completing it settles the books with no ROVIQ case', async () => {
    const req = await api('POST', `/api/shop-os/repair-orders/${roId}/parts-requirements`, { repairOrderLineId: lines.part });
    expect(req.statusCode).toBe(201);
    expect(req.json().requirement ?? req.json()).toMatchObject({ service_case_id: null, repair_order_id: roId });
    const reqId = (req.json().requirement ?? req.json()).id;
    for (const action of ['start', 'qc']) expect((await api('PATCH', `/api/shop-os/repair-orders/${roId}`, { action })).statusCode).toBe(200);
    expect((await api('PATCH', `/api/shop-os/repair-orders/${roId}`, { action: 'complete' })).statusCode).toBe(409);
    expect((await api('PATCH', `/api/shop-os/parts-requirements/${reqId}`, { readinessStatus: 'ready' })).statusCode).toBe(200);
    expect((await api('PATCH', `/api/shop-os/repair-orders/${roId}`, { action: 'complete' })).statusCode).toBe(200);
    const ledger = await pool.query(`select reconciliation_key, amount::float as amount, case_id from ledger_entries where repair_order_id=$1 order by reconciliation_key`, [roId]);
    expect(ledger.rows).toEqual([
      { reconciliation_key: 'shop_os_direct_cost', amount: -110, case_id: null },
      { reconciliation_key: 'shop_os_labor_cost', amount: -84, case_id: null },
      { reconciliation_key: 'shop_os_revenue', amount: 479, case_id: null }
    ]);
  });

  it('takes payment at the counter, never more than is owed, and shows it in the takings', async () => {
    const now = new Date();
    const range = `from=${encodeURIComponent(new Date(now.getTime() - 86400_000).toISOString())}&to=${encodeURIComponent(new Date(now.getTime() + 86400_000).toISOString())}&timeZone=America/Toronto`;
    const before = (await api('GET', `/api/shop-os/takings?${range}`)).json();
    expect(before.outstanding).toEqual([expect.objectContaining({ repairOrderId: roId, customer: 'Jordan Lee', vehicle: '2019 Honda CR-V', balance: 479 })]);
    expect(before.unsettledJobs).toBe(0);

    // Online payment needs Stripe, which this test environment does not configure.
    expect((await publicView()).json()).toMatchObject({ canPay: false, totals: { balance: 479 } });
    expect((await app.inject({ method: 'POST', url: `/api/public/shop-estimates/${token}/checkout` })).json().error).toBe('online_payment_unavailable');

    expect((await api('POST', `/api/shop-os/repair-orders/${roId}/payments`, { amount: 500, method: 'cash' })).statusCode).toBe(409);
    expect((await api('POST', `/api/shop-os/repair-orders/${roId}/payments`, { amount: 200, method: 'cash' })).statusCode).toBe(201);
    expect((await api('POST', `/api/shop-os/repair-orders/${roId}/payments`, { amount: 279, method: 'card_terminal', note: 'Terminal #2' })).statusCode).toBe(201);
    const payments = (await api('GET', `/api/shop-os/repair-orders/${roId}/payments`)).json();
    expect(payments).toMatchObject({ approvedAmount: 479, paid: 479, balance: 0, walkIn: true });
    expect((await api('POST', `/api/shop-os/repair-orders/${roId}/payments`, { amount: 1, method: 'cash' })).statusCode).toBe(409);

    const after = (await api('GET', `/api/shop-os/takings?${range}`)).json();
    expect(after.outstanding).toEqual([]);
    expect(after.totals).toMatchObject({ jobs: 1, revenue: 479, directCost: 110, laborCost: 84, contribution: 285, collected: 479 });
    expect(after.days[0].collected).toEqual({ cash: 200, card_terminal: 279 });
    expect((await api('GET', `/api/shop-os/takings?${range}`, undefined, other)).json().totals.jobs).toBe(0);
  });

  it('records a Stripe payment only when Stripe reports the exact amount paid', async () => {
    const ro = await api('POST', '/api/shop-os/repair-orders', { locationId, customerConcern: 'Oil change' });
    const id = ro.json().repairOrder.id;
    const pending = await pool.query(`insert into shop_payments(repair_order_id,organization_id,amount,method,status,provider) select $1, organization_id, 89.5, 'card_online','pending','stripe' from shop_repair_orders where id=$1 returning id`, [id]);
    const paymentId = pending.rows[0].id;
    const session = { id: `cs_test_${paymentId.replaceAll('-', '')}`, status: 'complete', payment_status: 'paid', currency: 'usd', payment_intent: 'pi_1', metadata: { roviq_shop_payment_id: paymentId } };
    await expect(applyShopCheckoutSession({ ...session, amount_total: 1000 }, 'webhook')).rejects.toThrow('checkout_amount_mismatch');
    expect(await applyShopCheckoutSession({ ...session, status: 'open', payment_status: 'unpaid', amount_total: 8950 }, 'return')).toMatchObject({ paid: false });
    expect(await applyShopCheckoutSession({ ...session, amount_total: 8950 }, 'webhook')).toMatchObject({ paid: true });
    expect(await applyShopCheckoutSession({ ...session, amount_total: 8950 }, 'return')).toMatchObject({ paid: true });
    expect((await pool.query('select status, provider_payment_intent_id from shop_payments where id=$1', [paymentId])).rows[0]).toEqual({ status: 'paid', provider_payment_intent_id: 'pi_1' });
  });

  it('replaces the link when the shop sends a new one', async () => {
    const fresh = (await api('POST', `/api/shop-os/repair-orders/${roId}/customer-link`)).json().url.split('/estimate/')[1];
    expect((await publicView(token)).statusCode).toBe(404);
    expect((await publicView(fresh)).statusCode).toBe(200);
  });
});
