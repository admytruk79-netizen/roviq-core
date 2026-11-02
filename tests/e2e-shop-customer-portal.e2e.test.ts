import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// The shop's own customer portal (Shop OS as a standalone shop system): one private link per
// customer shows their vehicles, current job progress, the shop's messages, the inspection report,
// approvals, history and recommended work, and nothing internal.

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };

describe('Shop OS customer portal', () => {
  let app: FastifyInstance;
  let shop: Record<string, string>;
  let other: Record<string, string>;
  let locationId: string;
  let customerId: string;
  let vehicles: string[];
  let current: string;
  let past: string;
  let token: string;

  async function onboard(name: string) {
    const email = `${randomUUID()}@shop.test`; const password = 'Portal-shop-2026!';
    const res = await app.inject({ method: 'POST', url: '/api/admin/business-onboarding', headers: admin, payload: {
      requestId: randomUUID(), role: 'partner', businessName: name, operatorName: 'Owner', email, password,
      location: { name, address: '9 King St', city: 'Toronto', region: 'ON', countryCode: 'CA' } } });
    await pool.query(`insert into business_service_authorizations(organization_id,service,state,valid_from,expires_at,evidence_reference,verified_at,review_reason)
      values($1,'repair','verified',now()-interval '1 day',now()+interval '1 year','Test licence',now(),'Verified for portal tests')`, [res.json().business.organizationId]);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return { headers: { authorization: `Bearer ${login.json().accessToken}` }, locationId: res.json().business.locationId as string };
  }
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers = shop) => app.inject({ method, url, headers, ...(payload ? { payload: payload as object } : {}) });
  const portal = (t = token) => app.inject({ method: 'GET', url: `/api/public/shop-portal/${t}` });
  async function order(vehicleId: string, concern: string, lines: Record<string, unknown>[]) {
    const id = (await api('POST', '/api/shop-os/repair-orders', { locationId, shopCustomerId: customerId, shopVehicleId: vehicleId, customerConcern: concern, internalNotes: 'INTERNAL: customer haggles' })).json().repairOrder.id;
    const ids: string[] = [];
    for (const l of lines) ids.push((await api('POST', `/api/shop-os/repair-orders/${id}/lines`, l)).json().line.id);
    expect((await api('PATCH', `/api/shop-os/repair-orders/${id}`, { action: 'submit_estimate' })).statusCode).toBe(200);
    return { id, lines: ids };
  }

  beforeAll(async () => {
    app = await buildApp();
    const a = await onboard('Portal Test Garage'); shop = a.headers; locationId = a.locationId;
    other = (await onboard('Other Portal Garage')).headers;
    const intake = (await api('POST', '/api/shop-os/local-intake', { locationId, displayName: 'Alex Moreau', phone: '416-555-0199', vehicle: { make: 'Toyota', model: 'RAV4 Hybrid', modelYear: 2022, licensePlate: 'CMNV 551' } })).json();
    customerId = intake.customer.id;
    const second = (await api('POST', `/api/shop-os/customers/${customerId}/vehicles`, { locationId, make: 'Mazda', model: 'MX-5', modelYear: 2016 })).json();
    vehicles = [intake.vehicle.id, second.vehicle.id];

    // Last month: an oil change, approved, done and paid.
    const done = await order(vehicles[0], 'Oil change', [{ lineType: 'labor', description: 'Oil and filter change', quantity: 1, unitPrice: 89, unitCost: 30 }]);
    past = done.id;
    await api('PATCH', `/api/shop-os/repair-orders/${past}/lines/${done.lines[0]}`, { approvalStatus: 'approved' });
    for (const action of ['approve', 'start', 'qc', 'complete']) expect((await api('PATCH', `/api/shop-os/repair-orders/${past}`, { action })).statusCode).toBe(200);
    await api('POST', `/api/shop-os/repair-orders/${past}/payments`, { amount: 89, method: 'card_terminal' });

    // Today: brakes, inspected, waiting for the customer.
    const now = await order(vehicles[0], 'Squeal when braking', [
      { lineType: 'labor', description: 'Rear brake pads replace', quantity: 1.5, unitPrice: 145, unitCost: 45 },
      { lineType: 'part', description: 'Rear ceramic pads', quantity: 1, unitPrice: 79, unitCost: 33 },
      { lineType: 'labor', description: 'Cabin air filter', quantity: 0.3, unitPrice: 145, unitCost: 45 }
    ]);
    current = now.id;
    const dvi = (await api('POST', `/api/shop-os/repair-orders/${current}/dvi`, { summary: 'Rear pads at 2 mm, everything else fine' })).json().inspection.id;
    const finding = (await api('POST', `/api/shop-os/dvi/${dvi}/findings`, { section: 'Brakes', item: 'Rear pads', severity: 'urgent', measurement: '2 mm', technicianNote: 'TECH ONLY: rotor lip', customerNote: 'Pads are almost gone; replace now.' })).json().finding.id;
    await api('POST', `/api/shop-os/dvi/${dvi}/findings`, { section: 'Tires', item: 'Front tires', severity: 'good', measurement: '7/32"' });
    await api('POST', `/api/shop-os/dvi/${dvi}/evidence`, { findingId: finding, mediaType: 'photo', storageKey: 'https://example.test/pads.jpg', caption: 'Rear pad' });
    await api('POST', `/api/shop-os/dvi/${dvi}/evidence`, { findingId: finding, mediaType: 'photo', storageKey: 'https://example.test/internal.jpg', customerVisible: false });
    expect((await api('PATCH', `/api/shop-os/dvi/${dvi}/submit`)).statusCode).toBe(200);
    expect((await api('POST', `/api/shop-os/repair-orders/${current}/customer-updates`, { message: 'Your RAV4 is on the lift. Estimate is ready for you.' })).statusCode).toBe(201);
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  it('gives the customer one private page for all their vehicles and jobs, with nothing internal', async () => {
    const link = await api('POST', `/api/shop-os/customers/${customerId}/portal-link`);
    expect(link.statusCode).toBe(201);
    token = link.json().url.split('/shop/')[1];
    const res = await portal();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shop.name).toBe('Portal Test Garage');
    expect(body.customer).toEqual({ name: 'Alex' });
    expect(body.vehicles.map((v: { name: string }) => v.name)).toEqual(['2022 Toyota RAV4 Hybrid', '2016 Mazda MX-5']);
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual([current, past]);
    const [now, before] = body.jobs;
    expect(now).toMatchObject({ stage: 'approval', statusText: 'Waiting for your approval', active: true, canDecide: true, canPay: false, vehicle: '2022 Toyota RAV4 Hybrid', totals: { estimate: 340 } });
    expect(now.updates).toEqual([expect.objectContaining({ message: 'Your RAV4 is on the lift. Estimate is ready for you.' })]);
    expect(now.inspection.findings).toEqual([
      { section: 'Brakes', item: 'Rear pads', condition: 'urgent', measurement: '2 mm', note: 'Pads are almost gone; replace now.', photos: [{ url: 'https://example.test/pads.jpg', caption: 'Rear pad' }] },
      { section: 'Tires', item: 'Front tires', condition: 'good', measurement: '7/32"', note: null, photos: [] }
    ]);
    expect(before).toMatchObject({ stage: 'ready', active: false, totals: { approved: 89, paid: 89, balance: 0 } });
    expect(JSON.stringify(body)).not.toMatch(/INTERNAL|TECH ONLY|internal\.jpg|unit_cost|unitCost|416-555|haggles/);
  });

  it('lets the customer approve today’s job from the portal, and only their own jobs', async () => {
    const lines = (await portal()).json().jobs[0].lines;
    const decide = (jobId: string) => app.inject({ method: 'POST', url: `/api/public/shop-portal/${token}/jobs/${jobId}/decision`, payload: {
      decisions: lines.map((l: { id: string; description: string }) => ({ lineId: l.id, decision: l.description === 'Cabin air filter' ? 'declined' : 'approved' })) } });
    expect((await decide(randomUUID())).statusCode).toBe(404);
    const ok = await decide(current);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'approved', approvedAmount: 296.5 });
    expect((await portal()).json().jobs[0]).toMatchObject({ stage: 'repair', canDecide: false });
    expect((await decide(current)).statusCode).toBe(409);
    // Payment opens once the job is done; online card payment also needs Stripe, absent in tests.
    expect((await app.inject({ method: 'POST', url: `/api/public/shop-portal/${token}/jobs/${current}/checkout` })).statusCode).toBe(409);
  });

  it('turns "not now" into recommended work and keeps other shops out', async () => {
    expect((await portal()).json().recommended).toEqual([expect.objectContaining({ description: 'Cabin air filter', severity: 'recommended', estimate: 43.5, vehicle: '2022 Toyota RAV4 Hybrid' })]);
    const deferred = await pool.query(`select d.status, d.next_follow_up_at > now() + interval '29 days' as later from shop_deferred_service_items d where d.repair_order_id=$1`, [current]);
    expect(deferred.rows).toEqual([{ status: 'open', later: true }]);
    expect([403, 404]).toContain((await api('POST', `/api/shop-os/customers/${customerId}/portal-link`, undefined, other)).statusCode);
    expect([403, 404]).toContain((await api('POST', `/api/shop-os/repair-orders/${current}/customer-updates`, { message: 'hi' }, other)).statusCode);
    expect((await api('GET', `/api/shop-os/repair-orders/${current}/customer-updates`)).json()).toMatchObject({ shopCustomerId: customerId, portal: expect.objectContaining({ last_viewed_at: expect.any(String) }) });
  });

  it('stops the old link when the shop sends a new one', async () => {
    const fresh = (await api('POST', `/api/shop-os/customers/${customerId}/portal-link`)).json().url.split('/shop/')[1];
    expect((await portal(token)).statusCode).toBe(404);
    expect((await portal(fresh)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/public/shop-portal/not-a-valid-token-at-all' })).statusCode).toBe(404);
  });
});
