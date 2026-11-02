import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';
import { stripeSecretKey } from './stripe-config.js';
import {
  checkoutOrder, confirmOrderCheckout, decideOrder, DECIDABLE_STATUS, hashToken, httpError, money, PAYABLE_STATUSES, type Decision
} from './shop-customer-links.js';

// The shop's own customer portal. Shop OS replaces a shop's management system (Tekmetric and the
// like), so its customers get the shop's page, not a ROVIQ account: one private link per customer
// opens their vehicles, the job in the shop right now with live progress and the shop's messages,
// the inspection report, approvals, payment, service history and work recommended for later.
// Nothing internal is shown: no costs, technician notes, pay rates or other customers.

type Queryable = Pick<PoolClient, 'query'>;
const PORTAL_DAYS = 90;
const MAX_JOBS = 25;

// The customer-facing progress of a repair order, in order.
export const PROGRESS = ['checked_in', 'inspection', 'approval', 'repair', 'final_check', 'ready'] as const;
const STAGE: Record<string, (typeof PROGRESS)[number] | 'done' | 'cancelled'> = {
  draft: 'inspection', estimate_pending: 'inspection', awaiting_approval: 'approval', approved: 'repair', in_progress: 'repair',
  waiting_parts: 'repair', waiting_customer: 'repair', quality_control: 'final_check', completed: 'ready', closed: 'done', cancelled: 'cancelled'
};
const STATUS_TEXT: Record<string, string> = {
  draft: 'We’re inspecting your vehicle', estimate_pending: 'We’re preparing your estimate', awaiting_approval: 'Waiting for your approval',
  approved: 'Approved — your repair is scheduled', in_progress: 'Your vehicle is being repaired', waiting_parts: 'Waiting for parts to arrive',
  waiting_customer: 'We need to hear from you', quality_control: 'Final checks and test drive', completed: 'Ready for pickup', closed: 'Complete', cancelled: 'Cancelled'
};

async function scopedCustomer(principal: Principal, shopCustomerId: string, db: Queryable) {
  const r = await db.query('select * from shop_customers where id=$1', [shopCustomerId]);
  if (!r.rowCount) throw httpError('shop_customer_not_found', 404);
  await resolveShopPrincipalScope(principal, { organizationId: r.rows[0].organization_id, locationId: r.rows[0].location_id ?? undefined }, db);
  return r.rows[0];
}

/** A private portal link for one of the shop's own customers; any earlier one stops working. */
export async function createPortalLink(principal: Principal, shopCustomerId: string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const customer = await scopedCustomer(principal, shopCustomerId, client);
    await client.query('update shop_customer_portal_links set revoked_at=now() where shop_customer_id=$1 and revoked_at is null', [customer.id]);
    const token = randomBytes(24).toString('base64url');
    const link = (await client.query(
      `insert into shop_customer_portal_links(shop_customer_id,organization_id,token_hash,created_by_actor_id,expires_at)
       values($1,$2,$3,$4,now()+make_interval(days=>$5)) returning id, expires_at`,
      [customer.id, customer.organization_id, hashToken(token), principal.actorId ?? null, PORTAL_DAYS]
    )).rows[0];
    await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload) values('shop_customer',$1,'SHOP_OS_CUSTOMER_PORTAL_LINK_CREATED',$2,$3,$4)`,
      [customer.id, principal.actorId ?? null, principal.role, JSON.stringify({ linkId: link.id })]);
    await client.query('commit');
    const origin = (process.env.CUSTOMER_APP_ORIGIN ?? 'https://roviq-core-customer.pages.dev').replace(/\/$/, '');
    return { url: `${origin}/shop/${token}`, expiresAt: link.expires_at };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

/** The portal link's customer, or 404. */
async function loadPortal(token: string, db: Queryable) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw httpError('link_not_found', 404);
  const r = await db.query(
    `select l.id as portal_link_id, c.* from shop_customer_portal_links l join shop_customers c on c.id=l.shop_customer_id
      where l.token_hash=$1 and l.revoked_at is null and l.expires_at>now()`, [hashToken(token)]);
  if (!r.rowCount) throw httpError('link_not_found', 404);
  return r.rows[0];
}

/** One of this customer's repair orders, locked when asked. Network (ROVIQ case) jobs are not shown here. */
function portalOrder(token: string, repairOrderId: string) {
  return async (db: Queryable, forUpdate: boolean) => {
    const customer = await loadPortal(token, db);
    const r = await db.query(
      `select o.* from shop_repair_orders o where o.id=$1 and o.shop_customer_id=$2 and o.organization_id=$3 and o.service_case_id is null${forUpdate ? ' for update' : ''}`,
      [repairOrderId, customer.id, customer.organization_id]);
    if (!r.rowCount) throw httpError('job_not_found', 404);
    return { ...r.rows[0], portal_link_id: customer.portal_link_id };
  };
}

/** Everything the customer sees on their portal. */
export async function viewPortal(token: string) {
  const customer = await loadPortal(token, pool);
  await pool.query('update shop_customer_portal_links set last_viewed_at=now() where id=$1', [customer.portal_link_id]);
  const [shop, vehicles, orders] = await Promise.all([
    pool.query(`select o.display_name as name, l.address, l.city, l.region from organizations o left join locations l on l.id=$2 where o.id=$1`, [customer.organization_id, customer.location_id]),
    pool.query(`select id, make, model, model_year, license_plate from shop_vehicles where shop_customer_id=$1 order by created_at`, [customer.id]),
    pool.query(`select o.*, coalesce((select sum(amount) from shop_payments p where p.repair_order_id=o.id and p.status='paid'),0) as paid
                  from shop_repair_orders o where o.shop_customer_id=$1 and o.organization_id=$2 and o.service_case_id is null and o.status<>'cancelled'
                 order by o.created_at desc limit $3`, [customer.id, customer.organization_id, MAX_JOBS])
  ]);
  const ids = orders.rows.map((o) => o.id);
  const [lines, updates, inspections, recommended, appointments] = await Promise.all([
    pool.query(`select id, repair_order_id, line_type, description, quantity, unit_price, approval_status from shop_repair_order_lines where repair_order_id=any($1::uuid[]) order by sort_order, created_at, id`, [ids]),
    pool.query(`select repair_order_id, message, created_at from shop_customer_updates where repair_order_id=any($1::uuid[]) order by created_at desc`, [ids]),
    pool.query(`select distinct on (i.repair_order_id) i.id, i.repair_order_id, i.summary, i.submitted_at,
                  coalesce((select json_agg(json_build_object('section',f.section,'item',f.item,'condition',f.severity,'measurement',f.measurement,'note',f.customer_note,
                      'photos',coalesce((select json_agg(json_build_object('url',e.storage_key,'caption',e.caption)) from shop_dvi_evidence e
                                          where e.finding_id=f.id and e.customer_visible and e.media_type='photo' and e.storage_key ~ '^https://'),'[]'::json))
                    order by case f.severity when 'urgent' then 0 when 'attention' then 1 else 2 end, f.sort_order, f.id) from shop_dvi_findings f where f.inspection_id=i.id and f.severity<>'not_inspected'),'[]'::json) as findings
                  from shop_dvi_inspections i where i.repair_order_id=any($1::uuid[]) and i.status='submitted'
                 order by i.repair_order_id, i.submitted_at desc`, [ids]),
    pool.query(`select d.id, l.description, d.severity, d.estimated_amount, d.target_return_at, o.shop_vehicle_id
                  from shop_deferred_service_items d join shop_repair_order_lines l on l.id=d.repair_order_line_id join shop_repair_orders o on o.id=d.repair_order_id
                 where o.shop_customer_id=$1 and d.status in ('open','reminded') order by d.severity desc, d.created_at`, [customer.id]),
    pool.query(`select a.id, a.starts_at, a.ends_at, a.appointment_status, a.customer_visible_summary, a.shop_vehicle_id from roviq_appointments a
                 where a.shop_customer_id=$1 and a.appointment_status in ('held','confirmed') and a.ends_at>now() order by a.starts_at limit 5`, [customer.id])
  ]);
  const vehicleName = (id: string | null) => {
    const v = vehicles.rows.find((x) => x.id === id);
    return v ? [v.model_year, v.make, v.model].filter(Boolean).join(' ') : null;
  };
  const payable = Boolean(stripeSecretKey());
  const jobs = orders.rows.map((o) => {
    const approved = money(o.approved_amount); const paid = money(o.paid); const balance = Math.max(0, money(approved - paid));
    const stage = STAGE[o.status] ?? 'inspection';
    const inspection = inspections.rows.find((i) => i.repair_order_id === o.id);
    return {
      id: o.id, number: o.repair_order_number, vehicle: vehicleName(o.shop_vehicle_id), concern: o.customer_concern,
      status: o.status, statusText: STATUS_TEXT[o.status] ?? o.status, stage, active: !['closed', 'cancelled'].includes(o.status) && !(o.status === 'completed' && balance === 0),
      openedAt: o.created_at, completedAt: o.completed_at, odometer: o.odometer,
      lines: lines.rows.filter((l) => l.repair_order_id === o.id).map((l) => ({ id: l.id, type: l.line_type, description: l.description, quantity: Number(l.quantity), unitPrice: money(l.unit_price), amount: money(Number(l.quantity) * Number(l.unit_price)), approvalStatus: l.approval_status })),
      totals: { estimate: money(o.subtotal_amount), approved, paid, balance },
      updates: updates.rows.filter((u) => u.repair_order_id === o.id).map((u) => ({ message: u.message, at: u.created_at })),
      inspection: inspection ? { summary: inspection.summary, submittedAt: inspection.submitted_at, findings: inspection.findings } : null,
      canDecide: o.status === DECIDABLE_STATUS,
      canPay: PAYABLE_STATUSES.includes(o.status) && balance > 0 && payable
    };
  });
  return {
    shop: shop.rows[0] ?? { name: 'Your shop' },
    customer: { name: String(customer.display_name ?? '').split(' ')[0] || null },
    vehicles: vehicles.rows.map((v) => ({ id: v.id, name: [v.model_year, v.make, v.model].filter(Boolean).join(' '), plate: v.license_plate })),
    jobs,
    upcoming: appointments.rows.map((a) => ({ startsAt: a.starts_at, endsAt: a.ends_at, summary: a.customer_visible_summary, vehicle: vehicleName(a.shop_vehicle_id), confirmed: a.appointment_status === 'confirmed' })),
    recommended: recommended.rows.map((d) => ({ id: d.id, description: d.description, severity: d.severity, estimate: money(d.estimated_amount), suggestedBy: d.target_return_at, vehicle: vehicleName(d.shop_vehicle_id) })),
    progressSteps: PROGRESS
  };
}

export const decidePortalJob = (token: string, repairOrderId: string, decisions: Decision[]) => decideOrder(portalOrder(token, repairOrderId), decisions);

export const checkoutPortalJob = (token: string, repairOrderId: string, requestOrigin?: string) =>
  checkoutOrder(portalOrder(token, repairOrderId), `/shop/${token}?job=${repairOrderId}`, requestOrigin);

export async function confirmPortalCheckout(token: string, repairOrderId: string, sessionId: string) {
  return confirmOrderCheckout(await portalOrder(token, repairOrderId)(pool, false), sessionId);
}

/** A message from the shop to the customer about a job; it appears on the customer's portal. */
export async function postCustomerUpdate(principal: Principal, repairOrderId: string, message: string) {
  const r = await pool.query('select id, organization_id, location_id, service_case_id from shop_repair_orders where id=$1', [repairOrderId]);
  if (!r.rowCount) throw httpError('repair_order_not_found', 404);
  await resolveShopPrincipalScope(principal, { organizationId: r.rows[0].organization_id, locationId: r.rows[0].location_id ?? undefined }, pool);
  const row = (await pool.query(`insert into shop_customer_updates(repair_order_id,organization_id,message,created_by_actor_id) values($1,$2,$3,$4) returning id, message, created_at`,
    [repairOrderId, r.rows[0].organization_id, message.trim(), principal.actorId ?? null])).rows[0];
  return row;
}

export async function listCustomerUpdates(principal: Principal, repairOrderId: string) {
  const r = await pool.query('select organization_id, location_id, shop_customer_id from shop_repair_orders where id=$1', [repairOrderId]);
  if (!r.rowCount) throw httpError('repair_order_not_found', 404);
  await resolveShopPrincipalScope(principal, { organizationId: r.rows[0].organization_id, locationId: r.rows[0].location_id ?? undefined }, pool);
  const [updates, portal] = await Promise.all([
    pool.query('select id, message, created_at from shop_customer_updates where repair_order_id=$1 order by created_at desc limit 50', [repairOrderId]),
    r.rows[0].shop_customer_id
      ? pool.query('select expires_at, last_viewed_at from shop_customer_portal_links where shop_customer_id=$1 and revoked_at is null and expires_at>now() order by created_at desc limit 1', [r.rows[0].shop_customer_id])
      : Promise.resolve({ rows: [] as Record<string, unknown>[] })
  ]);
  return { updates: updates.rows, portal: portal.rows[0] ?? null, shopCustomerId: r.rows[0].shop_customer_id ?? null };
}
