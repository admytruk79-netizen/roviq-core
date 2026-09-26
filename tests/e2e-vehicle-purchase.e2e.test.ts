import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}

describe('vehicle purchase booking and tracking', () => {
  let app: FastifyInstance;
  let vehicleId: string;
  let staleVehicleId: string;

  beforeEach(async () => {
    app = await buildApp();
    const vehicle = await pool.query(
      `insert into vehicle_inventory(source_key,source_vehicle_id,vin,year,make,model,trim,mileage,source_price_cents,margin_cents,markup_bps,condition,source_dealer_name,last_seen_at)
       values('e2e-dealer',$1,'1FTFW1E5XNFA00001',2023,'Ford','F-150','XLT',12000,4000000,0,850,'used','E2E Test Dealer',now())
       returning id`,
      [`stock-${Date.now()}`]
    );
    vehicleId = vehicle.rows[0].id;

    // A vehicle whose feed hasn't refreshed in over 24h -- must not be bookable even though the
    // row still exists, matching the same freshness rule the public listing itself enforces.
    const stale = await pool.query(
      `insert into vehicle_inventory(source_key,source_vehicle_id,vin,year,make,model,trim,source_price_cents,margin_cents,markup_bps,condition,last_seen_at)
       values('e2e-dealer',$1,'1FTFW1E5XNFA00002',2022,'Ford','F-250','Lariat',5000000,0,850,'used',now()-interval '2 days')
       returning id`,
      [`stock-stale-${Date.now()}`]
    );
    staleVehicleId = stale.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('books a vehicle with the public (marked-up) price, not the dealer cost, and returns a tracking token', async () => {
    const inventoryRes = await app.inject({ method: 'GET', url: `/api/inventory?q=F-150` });
    expect(inventoryRes.statusCode).toBe(200);
    const listed = JSON.parse(inventoryRes.body).inventory.find((v: { id: string }) => v.id === vehicleId);
    expect(listed).toBeTruthy();
    const publicPriceCents = listed.public_price_cents;
    expect(publicPriceCents).toBeGreaterThan(4000000); // dealer cost plus the 8.5% markup, not the raw cost itself

    const bookRes = await app.inject({
      method: 'POST', url: `/api/inventory/${vehicleId}/book`,
      payload: { contactName: 'Jordan Rivers', contactEmail: 'jordan@example.com', notes: 'Interested in a test drive Saturday' }
    });
    expect(bookRes.statusCode).toBe(201);
    const booked = JSON.parse(bookRes.body);
    expect(booked.inquiry.status).toBe('inquired');
    expect(booked.inquiry.offerPriceCents).toBe(publicPriceCents);
    expect(typeof booked.trackingToken).toBe('string');
    expect(booked.trackingToken.length).toBeGreaterThan(20);

    // No dealer cost, no dealer name -- only public-safe fields -- reach the anonymous customer.
    const trackRes = await app.inject({ method: 'GET', url: `/api/inventory/track/${booked.trackingToken}` });
    expect(trackRes.statusCode).toBe(200);
    const tracked = JSON.parse(trackRes.body).inquiry;
    expect(tracked.status).toBe('inquired');
    expect(tracked.offer_price_cents).toBe(publicPriceCents);
    expect(tracked.source_price_cents).toBeUndefined();
    expect(tracked.source_dealer_name).toBeUndefined();
    expect(tracked.timeline.map((e: { event_type: string }) => e.event_type)).toEqual(['VEHICLE_PURCHASE_INQUIRY_CREATED']);
  });

  it('requires at least one contact method and rejects a vehicle that is stale or missing', async () => {
    const noContact = await app.inject({
      method: 'POST', url: `/api/inventory/${vehicleId}/book`, payload: { contactName: 'No Contact Given' }
    });
    expect(noContact.statusCode).toBe(400); // zod .refine() failure

    const stale = await app.inject({
      method: 'POST', url: `/api/inventory/${staleVehicleId}/book`, payload: { contactName: 'Late Looker', contactPhone: '5035550100' }
    });
    expect(stale.statusCode).toBe(404);
    expect(JSON.parse(stale.body).error).toBe('vehicle_not_available');

    const missing = await app.inject({
      method: 'POST', url: `/api/inventory/${crypto.randomUUID()}/book`, payload: { contactName: 'Ghost Vehicle', contactPhone: '5035550100' }
    });
    expect(missing.statusCode).toBe(404);
  });

  it('drives an inquiry through the full purchase lifecycle with guarded transitions, visible to admin the whole way', async () => {
    const bookRes = await app.inject({
      method: 'POST', url: `/api/inventory/${vehicleId}/book`,
      payload: { contactName: 'Casey Lane', contactPhone: '503-555-0100' }
    });
    const { inquiry: { id: inquiryId }, trackingToken } = JSON.parse(bookRes.body);

    // Shows up in the admin queue immediately -- this is how ops "sees it".
    const queueRes = await app.inject({ method: 'GET', url: '/api/admin/inventory/inquiries?status=inquired', headers: adminHeaders() });
    expect(queueRes.statusCode).toBe(200);
    expect(JSON.parse(queueRes.body).inquiries.some((i: { id: string }) => i.id === inquiryId)).toBe(true);

    // Cannot skip straight from inquired to purchased.
    const skip = await app.inject({
      method: 'POST', url: `/api/admin/inventory/inquiries/${inquiryId}/status`, headers: adminHeaders(), payload: { status: 'purchased' }
    });
    expect(skip.statusCode).toBe(409);
    expect(JSON.parse(skip.body).error).toBe('invalid_inquiry_transition');

    for (const status of ['contacted', 'reserved', 'purchased', 'delivered']) {
      const res = await app.inject({
        method: 'POST', url: `/api/admin/inventory/inquiries/${inquiryId}/status`, headers: adminHeaders(), payload: { status }
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).inquiry.status).toBe(status);
    }

    // Terminal: delivered cannot transition anywhere else.
    const afterTerminal = await app.inject({
      method: 'POST', url: `/api/admin/inventory/inquiries/${inquiryId}/status`, headers: adminHeaders(), payload: { status: 'cancelled' }
    });
    expect(afterTerminal.statusCode).toBe(409);

    // The customer can trace every one of those status changes without ever logging in.
    const trackRes = await app.inject({ method: 'GET', url: `/api/inventory/track/${trackingToken}` });
    const tracked = JSON.parse(trackRes.body).inquiry;
    expect(tracked.status).toBe('delivered');
    expect(tracked.delivered_at).toBeTruthy();
    expect(tracked.timeline.map((e: { event_type: string }) => e.event_type)).toEqual([
      'VEHICLE_PURCHASE_INQUIRY_CREATED',
      'VEHICLE_PURCHASE_STATUS_CHANGED', 'VEHICLE_PURCHASE_STATUS_CHANGED', 'VEHICLE_PURCHASE_STATUS_CHANGED', 'VEHICLE_PURCHASE_STATUS_CHANGED'
    ]);

    // The admin detail view, unlike the customer's, does carry the dealer cost and identity.
    const adminDetail = await app.inject({ method: 'GET', url: `/api/admin/inventory/inquiries/${inquiryId}`, headers: adminHeaders() });
    expect(adminDetail.statusCode).toBe(200);
    const detail = JSON.parse(adminDetail.body).inquiry;
    expect(detail.source_price_cents).toBe('4000000');
    expect(detail.source_dealer_name).toBe('E2E Test Dealer');
  });

  it('rejects a non-admin trying to change inquiry status or browse the admin queue', async () => {
    const bookRes = await app.inject({
      method: 'POST', url: `/api/inventory/${vehicleId}/book`, payload: { contactName: 'Rae Kim', contactEmail: 'rae@example.com' }
    });
    const { inquiry: { id: inquiryId } } = JSON.parse(bookRes.body);

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerActorId = JSON.parse(customer.body).actor.id;
    const customerHeaders = { 'x-roviq-role': 'customer', 'x-roviq-actor-id': customerActorId };

    const forbiddenStatus = await app.inject({
      method: 'POST', url: `/api/admin/inventory/inquiries/${inquiryId}/status`, headers: customerHeaders, payload: { status: 'contacted' }
    });
    expect(forbiddenStatus.statusCode).toBe(403);

    const forbiddenQueue = await app.inject({ method: 'GET', url: '/api/admin/inventory/inquiries', headers: customerHeaders });
    expect(forbiddenQueue.statusCode).toBe(403);
  });
});
