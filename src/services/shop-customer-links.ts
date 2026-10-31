import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';
import { customerReturnOrigin, stripeRequest } from './stripe-checkout.js';
import { stripeSecretKey } from './stripe-config.js';

// Walk-in customers of a Shop OS shop have no ROVIQ account. The shop sends them a private link
// (copied, texted or emailed by the shop) where they see the estimate, approve or decline each
// line, and pay the approved amount by card once the work is done. The shop can also record a
// payment taken at the counter. Network (ROVIQ case) jobs keep using the customer app instead.

type Queryable = Pick<PoolClient, 'query'>;
const LINK_DAYS = 14;
const PAYABLE_STATUSES = ['completed', 'closed'];
const DECIDABLE_STATUS = 'awaiting_approval';

function httpError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const money = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;

async function loadShopOrder(principal: Principal, repairOrderId: string, db: Queryable, forUpdate = false) {
  const r = await db.query(`select * from shop_repair_orders where id=$1${forUpdate ? ' for update' : ''}`, [repairOrderId]);
  if (!r.rowCount) throw httpError('repair_order_not_found', 404);
  await resolveShopPrincipalScope(principal, { organizationId: r.rows[0].organization_id, locationId: r.rows[0].location_id ?? undefined }, db);
  return r.rows[0];
}

async function paidTotal(repairOrderId: string, db: Queryable) {
  const r = await db.query(`select coalesce(sum(amount),0)::numeric as paid from shop_payments where repair_order_id=$1 and status='paid'`, [repairOrderId]);
  return money(r.rows[0].paid);
}

async function event(db: Queryable, repairOrderId: string, type: string, actorRole: string, actorId: string | null, payload: Record<string, unknown>) {
  await db.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload) values('repair_order',$1,$2,$3,$4,$5)`,
    [repairOrderId, type, actorId, actorRole, JSON.stringify(payload)]);
}

/** A fresh private link for the walk-in customer; any earlier link for this order stops working. */
export async function createCustomerLink(principal: Principal, repairOrderId: string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const order = await loadShopOrder(principal, repairOrderId, client, true);
    if (order.service_case_id) throw httpError('repair_order_uses_roviq_app', 409);
    if (!order.shop_customer_id) throw httpError('repair_order_customer_required', 409);
    if (['draft', 'estimate_pending', 'cancelled'].includes(order.status)) throw httpError('estimate_not_ready', 409);
    await client.query(`update shop_customer_links set revoked_at=now() where repair_order_id=$1 and revoked_at is null`, [repairOrderId]);
    const token = randomBytes(24).toString('base64url');
    const link = (await client.query(
      `insert into shop_customer_links(repair_order_id,organization_id,token_hash,created_by_actor_id,expires_at)
       values($1,$2,$3,$4,now()+make_interval(days=>$5)) returning id,expires_at`,
      [repairOrderId, order.organization_id, hashToken(token), principal.actorId ?? null, LINK_DAYS]
    )).rows[0];
    await event(client, repairOrderId, 'SHOP_OS_CUSTOMER_LINK_CREATED', principal.role, principal.actorId ?? null, { linkId: link.id });
    await client.query('commit');
    const origin = (process.env.CUSTOMER_APP_ORIGIN ?? 'https://roviq-core-customer.pages.dev').replace(/\/$/, '');
    return { url: `${origin}/estimate/${token}`, expiresAt: link.expires_at };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

async function loadLink(token: string, db: Queryable, forUpdate = false) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw httpError('link_not_found', 404);
  const r = await db.query(
    `select l.id as link_id, l.expires_at, o.* from shop_customer_links l join shop_repair_orders o on o.id=l.repair_order_id
      where l.token_hash=$1 and l.revoked_at is null and l.expires_at>now()${forUpdate ? ' for update of o' : ''}`,
    [hashToken(token)]
  );
  if (!r.rowCount) throw httpError('link_not_found', 404);
  return r.rows[0];
}

/** What the walk-in customer sees: no internal notes, costs or other customers. */
export async function viewCustomerEstimate(token: string) {
  const order = await loadLink(token, pool);
  await pool.query('update shop_customer_links set last_viewed_at=now() where id=$1', [order.link_id]);
  const [shop, customer, vehicle, lines, paid] = await Promise.all([
    pool.query(`select o.display_name as name, l.address, l.city, l.region from organizations o left join locations l on l.id=$2 where o.id=$1`, [order.organization_id, order.location_id]),
    pool.query('select display_name from shop_customers where id=$1', [order.shop_customer_id]),
    pool.query('select make, model, model_year, license_plate from shop_vehicles where id=$1', [order.shop_vehicle_id]),
    pool.query(`select id, line_type, description, quantity, unit_price, approval_status from shop_repair_order_lines where repair_order_id=$1 order by sort_order, created_at, id`, [order.id]),
    paidTotal(order.id, pool)
  ]);
  const approved = money(order.approved_amount);
  const balance = Math.max(0, money(approved - paid));
  const v = vehicle.rows[0];
  return {
    shop: shop.rows[0] ?? { name: 'Your shop' },
    customerName: String(customer.rows[0]?.display_name ?? '').split(' ')[0] || null,
    vehicle: v ? [v.model_year, v.make, v.model].filter(Boolean).join(' ') : null,
    plate: v?.license_plate ?? null,
    repairOrderNumber: order.repair_order_number,
    concern: order.customer_concern,
    status: order.status,
    lines: lines.rows.map((l) => ({ id: l.id, type: l.line_type, description: l.description, quantity: Number(l.quantity), unitPrice: money(l.unit_price), amount: money(Number(l.quantity) * Number(l.unit_price)), approvalStatus: l.approval_status })),
    totals: { estimate: money(order.subtotal_amount), approved, paid, balance, currency: 'USD' },
    canDecide: order.status === DECIDABLE_STATUS,
    canPay: PAYABLE_STATUSES.includes(order.status) && balance > 0 && Boolean(stripeSecretKey()),
    expiresAt: order.expires_at
  };
}

/** The customer approves or declines every line; any approved line approves the estimate. */
export async function decideCustomerEstimate(token: string, decisions: { lineId: string; decision: 'approved' | 'declined' }[]) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const order = await loadLink(token, client, true);
    if (order.status !== DECIDABLE_STATUS) throw httpError('estimate_not_awaiting_approval', 409);
    const lines = (await client.query('select id from shop_repair_order_lines where repair_order_id=$1 for update', [order.id])).rows.map((l) => l.id as string);
    const byLine = new Map(decisions.map((d) => [d.lineId, d.decision]));
    if (byLine.size !== decisions.length || lines.length !== byLine.size || lines.some((id) => !byLine.has(id))) throw httpError('decision_required_for_every_line', 400);
    for (const id of lines) {
      const d = byLine.get(id)!;
      await client.query(`update shop_repair_order_lines set approval_status=$2,
          approved_at=case when $2='approved' then now() else null end, declined_at=case when $2='declined' then now() else null end,
          deferred_at=null, updated_at=now() where id=$1`, [id, d]);
    }
    const totals = (await client.query(`select coalesce(sum(case when approval_status='approved' then quantity*unit_price else 0 end),0)::numeric(12,2) as approved,
        count(*) filter (where approval_status='approved')::int as n from shop_repair_order_lines where repair_order_id=$1`, [order.id])).rows[0];
    const anyApproved = Number(totals.n) > 0;
    await client.query(`update shop_repair_orders set approved_amount=$2, status=case when $3 then 'approved' else status end,
        approved_at=case when $3 then now() else approved_at end, updated_at=now() where id=$1`, [order.id, totals.approved, anyApproved]);
    await client.query('update shop_customer_links set decided_at=now() where id=$1', [order.link_id]);
    await event(client, order.id, 'SHOP_OS_ESTIMATE_DECIDED_BY_CUSTOMER', 'shop_customer', null, {
      linkId: order.link_id, approved: decisions.filter((d) => d.decision === 'approved').map((d) => d.lineId), declined: decisions.filter((d) => d.decision === 'declined').map((d) => d.lineId)
    });
    await client.query('commit');
    return { status: anyApproved ? 'approved' : order.status, approvedAmount: money(totals.approved) };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

/** Card payment of the outstanding balance on Stripe's hosted page. */
export async function startCustomerCheckout(token: string, requestOrigin?: string) {
  if (!stripeSecretKey()) throw httpError('online_payment_unavailable', 409);
  const client = await pool.connect();
  let payment: { id: string; amount: number } | null = null;
  let order: Record<string, any>;
  try {
    await client.query('begin');
    order = await loadLink(token, client, true);
    if (!PAYABLE_STATUSES.includes(order.status)) throw httpError('repair_order_not_payable', 409);
    const balance = money(Number(order.approved_amount) - await paidTotal(order.id, client));
    if (balance <= 0) throw httpError('nothing_to_pay', 409);
    // One open online payment at a time: an earlier unfinished attempt is replaced.
    await client.query(`update shop_payments set status='cancelled', updated_at=now() where repair_order_id=$1 and status='pending' and method='card_online'`, [order.id]);
    payment = (await client.query(`insert into shop_payments(repair_order_id,organization_id,amount,method,status,provider) values($1,$2,$3,'card_online','pending','stripe') returning id, amount`,
      [order.id, order.organization_id, balance])).rows[0];
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }

  const origin = customerReturnOrigin(requestOrigin);
  const shop = await pool.query('select display_name from organizations where id=$1', [order.organization_id]);
  const body = new URLSearchParams({
    mode: 'payment',
    success_url: `${origin}/estimate/${token}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/estimate/${token}`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(Number(payment!.amount) * 100)),
    'line_items[0][price_data][product_data][name]': `${shop.rows[0]?.display_name ?? 'Repair'} · ${order.repair_order_number}`,
    'metadata[roviq_shop_payment_id]': payment!.id,
    'metadata[roviq_repair_order_id]': order.id,
    'payment_intent_data[metadata][roviq_shop_payment_id]': payment!.id
  });
  const session = await stripeRequest('checkout/sessions', { method: 'POST', body, idempotencyKey: `shop-payment-${payment!.id}` }) as { id: string; url: string };
  await pool.query('update shop_payments set provider_session_id=$2, updated_at=now() where id=$1', [payment!.id, session.id]);
  return { checkoutUrl: session.url };
}

type ShopCheckoutSession = { id: string; status?: string | null; payment_status?: string | null; payment_intent?: string | null; amount_total?: number | null; currency?: string | null; metadata?: Record<string, string> | null };

/** Records a shop payment as paid once Stripe reports its Checkout Session paid. */
export async function applyShopCheckoutSession(session: ShopCheckoutSession, source: 'return' | 'webhook') {
  const paymentId = session.metadata?.roviq_shop_payment_id;
  if (!paymentId) throw new Error('checkout_session_unlinked');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await client.query('select * from shop_payments where id=$1 for update', [paymentId]);
    const p = r.rows[0];
    if (!p) throw new Error('payment_not_found');
    if (p.status === 'paid') { await client.query('commit'); return { paymentId, repairOrderId: p.repair_order_id as string, paid: true }; }
    if (session.status !== 'complete' || session.payment_status !== 'paid') { await client.query('commit'); return { paymentId, repairOrderId: p.repair_order_id as string, paid: false }; }
    if (String(session.currency ?? '').toUpperCase() !== String(p.currency).toUpperCase()) throw new Error('checkout_currency_mismatch');
    if (session.amount_total !== Math.round(Number(p.amount) * 100)) throw new Error('checkout_amount_mismatch');
    await client.query(`update shop_payments set status='paid', paid_at=now(), provider_session_id=coalesce(provider_session_id,$2), provider_payment_intent_id=$3, updated_at=now() where id=$1`,
      [paymentId, session.id, session.payment_intent ?? null]);
    await event(client, p.repair_order_id, 'SHOP_OS_PAYMENT_RECEIVED', 'shop_customer', null, { paymentId, method: 'card_online', amount: money(p.amount), source });
    await client.query('commit');
    return { paymentId, repairOrderId: p.repair_order_id as string, paid: true };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

/** Back from Stripe: ask Stripe, never the browser, whether it was paid. */
export async function confirmCustomerCheckoutByLink(token: string, sessionId: string) {
  const order = await loadLink(token, pool);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw httpError('checkout_session_invalid', 400);
  const session = await stripeRequest(`checkout/sessions/${encodeURIComponent(sessionId)}`) as ShopCheckoutSession;
  if (session.metadata?.roviq_repair_order_id !== order.id) throw httpError('checkout_session_invalid', 400);
  return applyShopCheckoutSession(session, 'return');
}

/** A payment the shop took itself: cash, its own card terminal, or anything else. */
export async function recordCounterPayment(principal: Principal, repairOrderId: string, input: { amount: number; method: 'card_terminal' | 'cash' | 'other'; note?: string }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const order = await loadShopOrder(principal, repairOrderId, client, true);
    if (['draft', 'estimate_pending', 'awaiting_approval', 'cancelled'].includes(order.status)) throw httpError('repair_order_not_payable', 409);
    const balance = money(Number(order.approved_amount) - await paidTotal(repairOrderId, client));
    const amount = money(input.amount);
    if (amount <= 0 || amount > balance) throw httpError('payment_exceeds_balance', 409);
    const p = (await client.query(`insert into shop_payments(repair_order_id,organization_id,amount,method,status,note,recorded_by_actor_id,paid_at)
        values($1,$2,$3,$4,'paid',$5,$6,now()) returning *`, [repairOrderId, order.organization_id, amount, input.method, input.note?.trim() || null, principal.actorId ?? null])).rows[0];
    await event(client, repairOrderId, 'SHOP_OS_PAYMENT_RECEIVED', principal.role, principal.actorId ?? null, { paymentId: p.id, method: input.method, amount });
    await client.query('commit');
    return p;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

/** Payments on one repair order and what is still owed. */
export async function repairOrderPayments(principal: Principal, repairOrderId: string) {
  const order = await loadShopOrder(principal, repairOrderId, pool);
  const [payments, link] = await Promise.all([
    pool.query(`select id, amount, currency, method, status, note, paid_at, created_at from shop_payments where repair_order_id=$1 and status in ('paid','pending') order by created_at desc`, [repairOrderId]),
    pool.query(`select expires_at, last_viewed_at, decided_at from shop_customer_links where repair_order_id=$1 and revoked_at is null and expires_at>now() order by created_at desc limit 1`, [repairOrderId])
  ]);
  const paid = money(payments.rows.filter((p) => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0));
  return {
    payments: payments.rows,
    approvedAmount: money(order.approved_amount),
    paid,
    balance: Math.max(0, money(Number(order.approved_amount) - paid)),
    walkIn: !order.service_case_id && Boolean(order.shop_customer_id),
    activeLink: link.rows[0] ?? null
  };
}
