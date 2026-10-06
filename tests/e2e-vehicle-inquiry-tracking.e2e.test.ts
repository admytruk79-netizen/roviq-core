import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}

describe('vehicle inquiry status tracking', () => {
  let app: FastifyInstance;
  const vin = '1FTEW2LP5TKE63673';

  beforeEach(async () => {
    app = await buildApp();
    await pool.query(
      `insert into vehicle_inventory(source_key,source_vehicle_id,vin,year,make,model,trim,mileage,source_price_cents,margin_cents,markup_bps,condition,source_dealer_name,last_seen_at)
       values('e2e-dealer',$1,$2,2026,'Ford','F-150','XLT',12000,4000000,0,850,'used','E2E Test Dealer',now())`,
      [`stock-${Date.now()}`, vin]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function book() {
    const res = await app.inject({
      method: 'POST', url: '/api/inventory/inquiries',
      payload: { vin, name: 'Casey Lane', email: 'casey@example.com', phone: '503-555-0100' }
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { id: string; trackingToken: string; available: boolean };
  }

  it('returns a tracking token at booking time and lets the customer trace status without an account', async () => {
    const booked = await book();
    expect(booked.available).toBe(true);
    expect(typeof booked.trackingToken).toBe('string');
    expect(booked.trackingToken.length).toBeGreaterThan(20);

    const trackRes = await app.inject({ method: 'GET', url: `/api/inventory/inquiries/track/${booked.trackingToken}` });
    expect(trackRes.statusCode).toBe(200);
    const tracked = JSON.parse(trackRes.body).inquiry;
    expect(tracked.status).toBe('new');
    expect(tracked.timeline.map((e: { event_type: string }) => e.event_type)).toEqual(['VEHICLE_INQUIRY_CREATED']);

    // No dealer identity or dealer cost reaches the anonymous customer.
    expect(tracked.dealer_name).toBeUndefined();
    expect(tracked.source_price_cents).toBeUndefined();
  });

  it('rejects an unknown tracking token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inventory/inquiries/track/0000000000000000000000000000000000000000000000' });
    expect(res.statusCode).toBe(404);
  });

  it('drives an inquiry through the full lifecycle with guarded transitions, visible to the customer and admin throughout', async () => {
    const booked = await book();

    // Shows up in the admin queue immediately.
    const queueRes = await app.inject({ method: 'GET', url: '/api/admin/inventory/inquiries?status=new', headers: adminHeaders() });
    expect(queueRes.statusCode).toBe(200);
    expect(JSON.parse(queueRes.body).inquiries.some((i: { id: string }) => i.id === booked.id)).toBe(true);

    // Cannot skip straight from new to purchased.
    const skip = await app.inject({
      method: 'POST', url: `/api/admin/inventory/inquiries/${booked.id}/status`, headers: adminHeaders(), payload: { status: 'purchased' }
    });
    expect(skip.statusCode).toBe(409);
    expect(JSON.parse(skip.body).error).toBe('invalid_inquiry_transition');

    for (const status of ['contacted', 'reserved', 'purchased', 'delivered']) {
      const res = await app.inject({
        method: 'POST', url: `/api/admin/inventory/inquiries/${booked.id}/status`, headers: adminHeaders(), payload: { status }
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).inquiry.status).toBe(status);
    }

    // Terminal: delivered cannot transition anywhere else.
    const afterTerminal = await app.inject({
      method: 'POST', url: `/api/admin/inventory/inquiries/${booked.id}/status`, headers: adminHeaders(), payload: { status: 'cancelled' }
    });
    expect(afterTerminal.statusCode).toBe(409);

    // The customer can trace every one of those changes without ever logging in.
    const trackRes = await app.inject({ method: 'GET', url: `/api/inventory/inquiries/track/${booked.trackingToken}` });
    const tracked = JSON.parse(trackRes.body).inquiry;
    expect(tracked.status).toBe('delivered');
    expect(tracked.delivered_at).toBeTruthy();
    expect(tracked.timeline.map((e: { event_type: string }) => e.event_type)).toEqual([
      'VEHICLE_INQUIRY_CREATED',
      'VEHICLE_INQUIRY_STATUS_CHANGED', 'VEHICLE_INQUIRY_STATUS_CHANGED', 'VEHICLE_INQUIRY_STATUS_CHANGED', 'VEHICLE_INQUIRY_STATUS_CHANGED'
    ]);
  });

  it('rejects a non-admin trying to change inquiry status', async () => {
    const booked = await book();
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerActorId = JSON.parse(customer.body).actor.id;
    const res = await app.inject({
      method: 'POST', url: `/api/admin/inventory/inquiries/${booked.id}/status`,
      headers: { 'x-roviq-role': 'customer', 'x-roviq-actor-id': customerActorId }, payload: { status: 'contacted' }
    });
    expect(res.statusCode).toBe(403);
  });
});
