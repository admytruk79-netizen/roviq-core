import { afterEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/pool.js', () => ({ pool: { query } }));
import { createVehicleInquiry, notifyOwner, ownerEmail, type InventoryMatch } from './vehicle-inquiries.js';

const truck: InventoryMatch = {
  id: 'inv1', vin: '1FTEW2LP5TKE63673', year: 2026, make: 'Ford', model: 'F-150', trim: 'STX SuperCrew', condition: 'new',
  mileage: 0, public_price_cents: 4894500, source_price_cents: 4511100, source_dealer_name: 'Courtesy Ford (Portland)',
  source_dealer_url: 'https://www.courtesyford.com/inventory/new-2026-ford-f-150/', last_seen_at: '2026-09-27T06:00:00.000Z', available: true
};
const input = { vin: '1ftew2lp5tke63673', name: 'Olena', email: 'olena@example.com', phone: '+380 50 000 0000', note: 'Kyiv' };

afterEach(() => { query.mockReset(); vi.unstubAllEnvs(); });

describe('vehicle inquiries', () => {
  it('owner email names the truck, VIN, both prices, dealer and availability', () => {
    const m = ownerEmail(input, truck, 'req-1');
    expect(m.subject).toBe('Truck request: 2026 Ford F-150 STX SuperCrew — VIN 1ftew2lp5tke63673');
    expect(m.message).toContain('Availability: AVAILABLE');
    expect(m.message).toContain('Price quoted on ROVIQ: $48,945');
    expect(m.message).toContain('Dealer price: $45,111');
    expect(m.message).toContain('Dealer: Courtesy Ford (Portland)');
    expect(m.message).toContain('https://www.courtesyford.com/inventory/new-2026-ford-f-150/');
    expect(m.message).toContain('Customer: Olena');
  });

  it('stores the request with dealer details, logs a creation event, and returns a tracking token while skipping email until Resend is configured', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [truck] })
      .mockResolvedValueOnce({ rows: [{ id: 'req-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const fetcher = vi.fn();
    const r = await createVehicleInquiry(input, '203.0.113.9', fetcher as unknown as typeof fetch);
    expect(r).toMatchObject({ rateLimited: false, id: 'req-1', available: true, notified: false });
    if (r.rateLimited) throw new Error('unreachable');
    expect(typeof r.trackingToken).toBe('string');
    expect(r.trackingToken.length).toBeGreaterThan(20);
    expect(fetcher).not.toHaveBeenCalled();
    const params = query.mock.calls[2][1];
    expect(params.slice(0, 2)).toEqual(['1FTEW2LP5TKE63673', 'inv1']);
    expect(params.slice(6, 11)).toEqual([true, 4894500, 4511100, 'Courtesy Ford (Portland)', truck.source_dealer_url]);
    expect(query.mock.calls[3][0]).toContain('VEHICLE_INQUIRY_CREATED');
  });

  it('emails the owner through Resend when configured and marks the request notified', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubEnv('RESEND_FROM_EMAIL', 'ROVIQ <trucks@example.com>');
    vi.stubEnv('OWNER_NOTIFY_EMAIL', 'owner@example.com');
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [truck] })
      .mockResolvedValueOnce({ rows: [{ id: 'req-2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const r = await createVehicleInquiry(input, '203.0.113.9', fetcher as unknown as typeof fetch);
    expect(r).toMatchObject({ notified: true });
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ to: ['owner@example.com'], reply_to: 'olena@example.com' });
    expect(query.mock.calls[4][0]).toContain('owner_notified=true');
  });

  it('records a request for a truck no longer listed, and rate-limits repeat senders', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'req-3' }] });
    expect(await createVehicleInquiry(input, '198.51.100.1')).toMatchObject({ available: false, id: 'req-3' });
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ count: 5 }] });
    expect(await createVehicleInquiry(input, '198.51.100.1')).toEqual({ rateLimited: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('notifyOwner reports failure instead of throwing', async () => {
    vi.stubEnv('RESEND_API_KEY', 'k'); vi.stubEnv('RESEND_FROM_EMAIL', 'f@example.com'); vi.stubEnv('OWNER_NOTIFY_EMAIL', 'o@example.com');
    expect(await notifyOwner(ownerEmail(input, null, 'x'), (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBe(false);
  });
});
