import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

export type InquiryStatus = 'inquired' | 'contacted' | 'reserved' | 'financing' | 'purchased' | 'delivered' | 'cancelled';

// Mirrors the explicit allowed-transition-map pattern used everywhere else in Core (transport,
// mobility, exceptions) rather than letting a client jump straight to 'delivered'.
const ALLOWED_TRANSITIONS: Record<InquiryStatus, InquiryStatus[]> = {
  inquired: ['contacted', 'cancelled'],
  contacted: ['reserved', 'cancelled'],
  reserved: ['financing', 'purchased', 'cancelled'],
  financing: ['purchased', 'cancelled'],
  purchased: ['delivered'],
  delivered: [],
  cancelled: []
};

function generateTrackingToken() {
  return randomBytes(24).toString('hex');
}

/**
 * Books a specific live-inventory vehicle for a customer. No account is required -- the
 * customer is identified by contact info and the returned tracking token, matching the
 * zero-friction booking flow the business plan describes. The public (marked-up) price is
 * captured at booking time so it cannot silently drift if the live feed re-prices the car later.
 */
export async function createVehicleInquiry(input: {
  vehicleInventoryId: string;
  customerActorId?: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}) {
  if (!input.contactEmail && !input.contactPhone) throw new Error('contact_method_required');
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Only bookable while it's still live on the public site -- the same freshness/status rule
    // GET /api/inventory itself enforces, so a customer can never book a car that has already
    // dropped off the listing (sold, removed, or the feed has gone stale).
    // public_price_cents is bigint and this project runs pg with no int8 type parser registered,
    // so it comes back as a string unless cast -- cast it the same way inventory.ts's public
    // route does, so the price this inquiry snapshots is a plain number end to end.
    // vehicle_inventory has no currency column of its own -- every scraped listing is USD today
    // (see dealer-scrapers.ts), so that's what this inquiry records; not read from the vehicle row.
    const vehicle = await client.query(
      `select id, public_price_cents::int as public_price_cents, year, make, model
         from vehicle_inventory
        where id=$1 and status='active' and last_seen_at >= now() - interval '24 hours'`,
      [input.vehicleInventoryId]
    );
    if (!vehicle.rowCount) throw new Error('vehicle_not_available');
    const publicPriceCents = vehicle.rows[0].public_price_cents;
    if (publicPriceCents === null) throw new Error('vehicle_price_unavailable');

    const trackingToken = generateTrackingToken();
    const inserted = await client.query(
      `insert into vehicle_purchase_inquiries(
         vehicle_inventory_id, customer_actor_id, contact_name, contact_email, contact_phone,
         offer_price_cents, currency, tracking_token, notes
       ) values($1,$2,$3,$4,$5,$6,'USD',$7,$8) returning *`,
      [
        input.vehicleInventoryId, input.customerActorId ?? null, input.contactName,
        input.contactEmail ?? null, input.contactPhone ?? null,
        publicPriceCents, trackingToken, input.notes ?? null
      ]
    );
    const inquiry = inserted.rows[0];
    // RETURNING reflects offer_price_cents' actual bigint column type regardless of the JS
    // number we just inserted, so it comes back as a string again -- reuse the already-cast
    // value in hand instead of re-parsing it.
    inquiry.offer_price_cents = publicPriceCents;
    await client.query(
      `insert into events(aggregate_type, aggregate_id, event_type, actor_id, payload)
       values('vehicle_purchase_inquiry',$1,'VEHICLE_PURCHASE_INQUIRY_CREATED',$2,$3)`,
      [inquiry.id, input.customerActorId ?? null, JSON.stringify({
        vehicleInventoryId: input.vehicleInventoryId, offerPriceCents: publicPriceCents,
        vehicleSummary: { year: vehicle.rows[0].year, make: vehicle.rows[0].make, model: vehicle.rows[0].model }
      })]
    );
    await client.query('commit');
    return inquiry;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Admin-only status progression, e.g. as the real-world sale/delivery actually advances. */
export async function updateInquiryStatus(principal: Principal, inquiryId: string, nextStatus: InquiryStatus, notes?: string) {
  if (principal.role !== 'admin') throw new Error('forbidden');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query(`select * from vehicle_purchase_inquiries where id=$1 for update`, [inquiryId]);
    if (!current.rowCount) throw new Error('inquiry_not_found');
    const inquiry = current.rows[0];
    if (inquiry.status === nextStatus) {
      await client.query('commit');
      return inquiry;
    }
    if (!ALLOWED_TRANSITIONS[inquiry.status as InquiryStatus]?.includes(nextStatus)) throw new Error('invalid_inquiry_transition');

    const terminalColumn = nextStatus === 'purchased' ? 'purchased_at' : nextStatus === 'delivered' ? 'delivered_at' : nextStatus === 'cancelled' ? 'cancelled_at' : null;
    const updated = await client.query(
      `update vehicle_purchase_inquiries
          set status=$1, notes=coalesce($2,notes), updated_at=now()${terminalColumn ? `, ${terminalColumn}=now()` : ''}
        where id=$3 returning *`,
      [nextStatus, notes ?? null, inquiryId]
    );
    await client.query(
      `insert into events(aggregate_type, aggregate_id, event_type, actor_id, payload)
       values('vehicle_purchase_inquiry',$1,'VEHICLE_PURCHASE_STATUS_CHANGED',$2,$3)`,
      [inquiryId, principal.actorId ?? null, JSON.stringify({ from: inquiry.status, to: nextStatus, notes: notes ?? null })]
    );
    await client.query('commit');
    await audit(principal, 'update_vehicle_inquiry_status', 'vehicle_purchase_inquiry', inquiryId, `${inquiry.status}->${nextStatus}`, {});
    return updated.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function loadTimeline(inquiryId: string) {
  const r = await pool.query(
    `select event_type, occurred_at, payload from events
      where aggregate_type='vehicle_purchase_inquiry' and aggregate_id=$1
      order by occurred_at asc`,
    [inquiryId]
  );
  return r.rows;
}

/**
 * Customer-facing lookup by tracking token -- no login required. Deliberately projects only the
 * public-safe vehicle fields (the same ones GET /api/inventory exposes), never the dealer's
 * source price or dealer identity, which stay admin-only.
 */
export async function getInquiryByTrackingToken(trackingToken: string) {
  const r = await pool.query(
    `select i.id, i.status, i.offer_price_cents::int as offer_price_cents, i.currency, i.contact_name, i.created_at, i.updated_at,
            i.purchased_at, i.delivered_at, i.cancelled_at,
            v.year, v.make, v.model, v.trim, v.mileage, v.exterior_color, v.image_urls
       from vehicle_purchase_inquiries i
       join vehicle_inventory v on v.id=i.vehicle_inventory_id
      where i.tracking_token=$1`,
    [trackingToken]
  );
  if (!r.rowCount) return null;
  const timeline = await loadTimeline(r.rows[0].id);
  return { ...r.rows[0], timeline };
}

export async function getInquiryForAdmin(principal: Principal, inquiryId: string) {
  if (principal.role !== 'admin') throw new Error('forbidden');
  const r = await pool.query(
    `select i.*, v.year, v.make, v.model, v.trim, v.source_price_cents, v.margin_cents, v.markup_bps,
            v.source_dealer_name, v.image_urls
       from vehicle_purchase_inquiries i
       join vehicle_inventory v on v.id=i.vehicle_inventory_id
      where i.id=$1`,
    [inquiryId]
  );
  if (!r.rowCount) return null;
  const timeline = await loadTimeline(inquiryId);
  return { ...r.rows[0], timeline };
}

export async function listInquiriesForAdmin(principal: Principal, filters: { status?: InquiryStatus; limit?: number } = {}) {
  if (principal.role !== 'admin') throw new Error('forbidden');
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (filters.status) { params.push(filters.status); clauses.push(`i.status=$${params.length}`); }
  params.push(filters.limit ?? 200);
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const r = await pool.query(
    `select i.id, i.status, i.contact_name, i.contact_email, i.contact_phone, i.offer_price_cents, i.currency,
            i.created_at, i.updated_at, v.year, v.make, v.model, v.trim, v.source_dealer_name
       from vehicle_purchase_inquiries i
       join vehicle_inventory v on v.id=i.vehicle_inventory_id
       ${where}
       order by i.created_at desc limit $${params.length}`,
    params
  );
  return r.rows;
}
