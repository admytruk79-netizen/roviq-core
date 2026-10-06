import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

export type InquiryStatus = 'new' | 'contacted' | 'reserved' | 'financing' | 'purchased' | 'delivered' | 'cancelled';

// Mirrors the explicit allowed-transition-map pattern used elsewhere in Core (transport,
// mobility, exceptions) rather than letting a client jump straight to 'delivered'.
const ALLOWED_TRANSITIONS: Record<InquiryStatus, InquiryStatus[]> = {
  new: ['contacted', 'cancelled'],
  contacted: ['reserved', 'cancelled'],
  reserved: ['financing', 'purchased', 'cancelled'],
  financing: ['purchased', 'cancelled'],
  purchased: ['delivered'],
  delivered: [],
  cancelled: []
};

export type InventoryMatch = {
  id: string; vin: string; year: number | null; make: string; model: string; trim: string | null;
  condition: string | null; mileage: number | null; public_price_cents: number | null; source_price_cents: number | null;
  source_dealer_name: string | null; source_dealer_url: string | null; last_seen_at: Date | string; available: boolean;
};

export const vehicleTitle = (v: Pick<InventoryMatch, 'year' | 'make' | 'model' | 'trim'>) =>
  [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');

// Latest record for a VIN; "available" means the dealer still listed it in the last 24 hours.
export async function findInventoryByVin(vin: string): Promise<InventoryMatch | null> {
  const r = await pool.query(`
    select id,vin,year,make,model,trim,condition,mileage,public_price_cents::int as public_price_cents,
           source_price_cents::int as source_price_cents,source_dealer_name,source_dealer_url,last_seen_at,
           (status='active' and last_seen_at >= now() - interval '24 hours') as available
    from vehicle_inventory where upper(vin)=upper($1)
    order by (status='active' and last_seen_at >= now() - interval '24 hours') desc, last_seen_at desc limit 1`, [vin]);
  return r.rows[0] ?? null;
}

const dollars = (cents: number | null | undefined) =>
  cents == null ? 'not listed' : `$${Math.round(Number(cents) / 100).toLocaleString('en-US')}`;

export function ownerEmail(input: { name: string; email: string; phone?: string | null; note?: string | null; vin: string }, v: InventoryMatch | null, requestId: string) {
  const title = v ? vehicleTitle(v) : 'Unknown vehicle';
  const lines = [
    `New truck request ${requestId}`,
    '',
    `Truck: ${title}${v?.condition ? ` (${v.condition})` : ''}`,
    `VIN: ${input.vin}`,
    `Availability: ${v?.available ? 'AVAILABLE' : 'NOT CURRENTLY LISTED'}${v ? ` (dealer last listed it ${new Date(v.last_seen_at).toISOString()})` : ''}`,
    `Price quoted on ROVIQ: ${dollars(v?.public_price_cents)}`,
    `Dealer price: ${dollars(v?.source_price_cents)}`,
    `Dealer: ${v?.source_dealer_name ?? 'unknown'}`,
    `Dealer listing: ${v?.source_dealer_url ?? 'not available'}`,
    `Mileage: ${v?.mileage != null ? `${v.mileage.toLocaleString('en-US')} mi` : 'not listed'}`,
    '',
    `Customer: ${input.name}`,
    `Email: ${input.email}`,
    `Phone: ${input.phone || 'not given'}`,
    `Message: ${input.note || '(none)'}`
  ];
  return { email: input.email, subject: `Truck request: ${title} — VIN ${input.vin}`.slice(0, 200), message: lines.join('\n') };
}

// Emails the owner through Core's Resend account. Off until RESEND_API_KEY,
// RESEND_FROM_EMAIL and OWNER_NOTIFY_EMAIL are set; requests are stored either way.
export async function notifyOwner(payload: ReturnType<typeof ownerEmail>, fetcher: typeof fetch = fetch): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.OWNER_NOTIFY_EMAIL;
  if (!apiKey || !from || !to) return false;
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: payload.email, subject: payload.subject, text: payload.message }),
      signal: AbortSignal.timeout(15000)
    });
    return res.ok;
  } catch { return false; }
}

export async function createVehicleInquiry(
  input: { vin: string; name: string; email: string; phone?: string | null; note?: string | null },
  clientIp: string, fetcher: typeof fetch = fetch
) {
  const recent = await pool.query(
    `select count(*)::int as count from vehicle_inquiries where client_ip=$1 and created_at >= now() - interval '10 minutes'`, [clientIp]);
  if (Number(recent.rows[0]?.count ?? 0) >= 5) return { rateLimited: true as const };
  const v = await findInventoryByVin(input.vin);
  const trackingToken = randomBytes(24).toString('hex');
  const inserted = await pool.query(`
    insert into vehicle_inquiries(vin,vehicle_inventory_id,customer_name,customer_email,customer_phone,note,available_at_request,
      quoted_price_cents,source_price_cents,dealer_name,dealer_url,vehicle_title,client_ip,tracking_token)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [input.vin.toUpperCase(), v?.id ?? null, input.name, input.email, input.phone || null, input.note || null, Boolean(v?.available),
     v?.public_price_cents ?? null, v?.source_price_cents ?? null, v?.source_dealer_name ?? null, v?.source_dealer_url ?? null,
     v ? vehicleTitle(v) : null, clientIp, trackingToken]);
  const id: string = inserted.rows[0].id;
  await pool.query(
    `insert into events(aggregate_type,aggregate_id,event_type,payload) values('vehicle_inquiry',$1,'VEHICLE_INQUIRY_CREATED',$2)`,
    [id, JSON.stringify({ vin: input.vin.toUpperCase(), available: Boolean(v?.available) })]
  );
  const notified = await notifyOwner(ownerEmail(input, v, id), fetcher);
  if (notified) await pool.query(`update vehicle_inquiries set owner_notified=true where id=$1`, [id]);
  return { rateLimited: false as const, id, available: Boolean(v?.available), lastSeenAt: v?.last_seen_at ?? null, notified, trackingToken };
}

/** Admin-only status progression, e.g. as the real-world sale/delivery actually advances. */
export async function updateInquiryStatus(principal: Principal, inquiryId: string, nextStatus: InquiryStatus, note?: string) {
  if (principal.role !== 'admin') throw new Error('forbidden');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query(`select * from vehicle_inquiries where id=$1 for update`, [inquiryId]);
    if (!current.rowCount) throw new Error('inquiry_not_found');
    const inquiry = current.rows[0];
    if (inquiry.status === nextStatus) {
      await client.query('commit');
      return inquiry;
    }
    if (!ALLOWED_TRANSITIONS[inquiry.status as InquiryStatus]?.includes(nextStatus)) throw new Error('invalid_inquiry_transition');

    const terminalColumn = nextStatus === 'purchased' ? 'purchased_at' : nextStatus === 'delivered' ? 'delivered_at' : nextStatus === 'cancelled' ? 'cancelled_at' : null;
    const updated = await client.query(
      `update vehicle_inquiries set status=$1,updated_at=now()${terminalColumn ? `,${terminalColumn}=now()` : ''} where id=$2 returning *`,
      [nextStatus, inquiryId]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('vehicle_inquiry',$1,'VEHICLE_INQUIRY_STATUS_CHANGED',$2,$3)`,
      [inquiryId, principal.actorId ?? null, JSON.stringify({ from: inquiry.status, to: nextStatus, note: note ?? null })]
    );
    await client.query('commit');
    await audit(principal, 'update_vehicle_inquiry_status', 'vehicle_inquiry', inquiryId, `${inquiry.status}->${nextStatus}`, {});
    return updated.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function inquiryTimeline(inquiryId: string) {
  const r = await pool.query(
    `select event_type,occurred_at,payload from events where aggregate_type='vehicle_inquiry' and aggregate_id=$1 order by occurred_at asc`,
    [inquiryId]
  );
  return r.rows;
}

/**
 * Customer-facing lookup by tracking token -- no login required, same order-tracking-style
 * pattern as the rest of the no-account booking flow. Deliberately omits the dealer name/URL
 * and the dealer's own price, which stay admin-only.
 */
export async function getInquiryByTrackingToken(trackingToken: string) {
  const r = await pool.query(
    `select id,status,vin,vehicle_title,quoted_price_cents::int as quoted_price_cents,customer_name,
            created_at,updated_at,purchased_at,delivered_at,cancelled_at
       from vehicle_inquiries where tracking_token=$1`,
    [trackingToken]
  );
  if (!r.rowCount) return null;
  const timeline = await inquiryTimeline(r.rows[0].id);
  return { ...r.rows[0], timeline };
}

// Shared key between the owner's website and Core (SITE_DEALER_LOOKUP_KEY). Unset = lookup off.
export function siteKeyMatches(provided: unknown, expected = process.env.SITE_DEALER_LOOKUP_KEY): boolean {
  if (!expected || expected.length < 24 || typeof provided !== 'string' || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export type DealerDetails = {
  dealerName: string | null; dealerUrl: string | null; dealerPriceCents: number | null; roviqPriceCents: number | null;
  available: boolean; lastSeenAt: Date | string | null; from: 'inventory' | 'request';
};

// Dealer for each VIN: the current inventory record, else the snapshot kept with the latest request.
export async function dealerDetailsForVins(vins: string[]): Promise<Record<string, DealerDetails>> {
  const list = [...new Set(vins.map(v => v.toUpperCase()))];
  if (!list.length) return {};
  const inv = await pool.query(`
    select distinct on (upper(vin)) upper(vin) as vin,source_dealer_name,source_dealer_url,
           source_price_cents::int as source_price_cents,public_price_cents::int as public_price_cents,last_seen_at,
           (status='active' and last_seen_at >= now() - interval '24 hours') as available
    from vehicle_inventory where upper(vin) = any($1::text[])
    order by upper(vin),(status='active' and last_seen_at >= now() - interval '24 hours') desc,last_seen_at desc`, [list]);
  const req = await pool.query(`
    select distinct on (vin) vin,dealer_name,dealer_url,source_price_cents::int as source_price_cents,quoted_price_cents::int as quoted_price_cents
    from vehicle_inquiries where vin = any($1::text[]) order by vin,created_at desc`, [list]);
  const out: Record<string, DealerDetails> = {};
  for (const r of req.rows) out[r.vin] = { dealerName: r.dealer_name, dealerUrl: r.dealer_url, dealerPriceCents: r.source_price_cents,
    roviqPriceCents: r.quoted_price_cents, available: false, lastSeenAt: null, from: 'request' };
  for (const r of inv.rows) out[r.vin] = { dealerName: r.source_dealer_name, dealerUrl: r.source_dealer_url, dealerPriceCents: r.source_price_cents,
    roviqPriceCents: r.public_price_cents, available: Boolean(r.available), lastSeenAt: r.last_seen_at, from: 'inventory' };
  return out;
}
