import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { autoAssignPartsSupplier } from '../src/services/parts.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const SKU = 'AUTO-ASSIGN-SKU-001';

function adminHeaders() { return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY }; }
function actorHeaders(role: string, actorId: string) { return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId }; }

// Mirrors e2e-auto-routing.e2e.test.ts: exercises autoAssignPartsSupplier directly rather than the
// AUTO_ASSIGN_PARTS_SUPPLIER env flag itself, since env.ts parses process.env once at import time
// and other e2e files assume parts orders stay unassigned until an admin acts.
describe('automatic parts-supplier assignment', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let cheapestSupplierId: string;
  let midPriceSupplierId: string;
  let expensiveSupplierId: string;

  async function setPartsPolicyActive(active: boolean) {
    await pool.query(`update routing_policies set active=$1 where policy_key='parts_supplier_default'`, [active]);
  }

  async function createOrder(overrides:{ requiresBoth?:boolean } = {}) {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id;
    for (const toState of ['provider_selection', 'provider_pending', 'repair_in_progress']) {
      await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState } });
    }
    const items = overrides.requiresBoth
      ? [{ sku: SKU, quantity: 50 }]
      : [{ sku: SKU, quantity: 2 }];
    const orderRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/parts-orders`, headers: adminHeaders(),
      payload: { items }
    });
    return { caseId, orderId: JSON.parse(orderRes.body).order.id };
  }

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const cheapest = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    cheapestSupplierId = JSON.parse(cheapest.body).actor.id;
    const midPrice = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    midPriceSupplierId = JSON.parse(midPrice.body).actor.id;
    const expensive = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    expensiveSupplierId = JSON.parse(expensive.body).actor.id;

    await app.inject({ method: 'PUT', url: '/api/parts/inventory', headers: actorHeaders('parts', midPriceSupplierId), payload: { sku: SKU, quantityOnHand: 10, unitPrice: 10 } });
    await app.inject({ method: 'PUT', url: '/api/parts/inventory', headers: actorHeaders('parts', expensiveSupplierId), payload: { sku: SKU, quantityOnHand: 10, unitPrice: 50 } });
    // Enough stock to be a candidate for the 2-unit order (and the cheapest per unit), but not
    // enough for the 50-unit "no eligible supplier" scenario below.
    await app.inject({ method: 'PUT', url: '/api/parts/inventory', headers: actorHeaders('parts', cheapestSupplierId), payload: { sku: SKU, quantityOnHand: 3, unitPrice: 1 } });
  });

  afterAll(async () => { await pool.end(); });

  it('leaves the order unassigned when no parts_supplier_default policy is active', async () => {
    await setPartsPolicyActive(false);
    const { orderId } = await createOrder();
    const outcome = await autoAssignPartsSupplier({ role: 'admin' }, orderId);
    expect(outcome.policyRequired).toBe(true);
    expect(outcome.result).toBeNull();
    const orderRow = await pool.query('select status,supplier_actor_id from parts_orders where id=$1', [orderId]);
    expect(orderRow.rows[0].status).toBe('requested');
    expect(orderRow.rows[0].supplier_actor_id).toBeNull();
  });

  it('ranks fulfillable suppliers by policy and assigns the cheapest', async () => {
    await pool.query(
      `insert into routing_policies(domain_id, policy_key, version, active, configuration)
       select id, 'parts_supplier_default', 1, true, '{"weights":{"price":-1},"defaults":{"price":0}}'::jsonb
       from domains where code='maintenance'
       on conflict (domain_id, policy_key, version) do update set active=true,configuration=excluded.configuration,updated_at=now()`
    );
    try {
      const { orderId, caseId } = await createOrder();
      const outcome = await autoAssignPartsSupplier({ role: 'admin' }, orderId);
      expect(outcome.policyRequired).toBe(false);
      expect(outcome.result).not.toBeNull();
      // All three suppliers can fulfill this 2-unit order, so with a policy weighted purely on
      // price the cheapest one -- cheapestSupplierId (3 in stock, $1/unit) -- must win over
      // midPriceSupplierId ($10) and expensiveSupplierId ($50).
      expect(outcome.result!.order.supplier_actor_id).toBe(cheapestSupplierId);
      expect(outcome.result!.order.status).toBe('supplier_assigned');

      const meOrders = await app.inject({ method: 'GET', url: '/api/parts/me/orders', headers: actorHeaders('parts', cheapestSupplierId) });
      expect(JSON.parse(meOrders.body).orders.some((o: { id: string }) => o.id === orderId)).toBe(true);

      const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
      const events = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
      expect(events).toContain('PARTS_SUPPLIER_ASSIGNED');
    } finally {
      await setPartsPolicyActive(false);
    }
  });

  it('raises a case exception and leaves the order unassigned when no supplier can fulfill the full order', async () => {
    await pool.query(
      `insert into routing_policies(domain_id, policy_key, version, active, configuration)
       select id, 'parts_supplier_default', 1, true, '{"weights":{"price":-1},"defaults":{"price":0}}'::jsonb
       from domains where code='maintenance'
       on conflict (domain_id, policy_key, version) do update set active=true,configuration=excluded.configuration,updated_at=now()`
    );
    try {
      const { orderId, caseId } = await createOrder({ requiresBoth: true });
      const outcome = await autoAssignPartsSupplier({ role: 'admin' }, orderId);
      expect(outcome.policyRequired).toBe(false);
      expect(outcome.result).toBeNull();
      const orderRow = await pool.query('select status,supplier_actor_id from parts_orders where id=$1', [orderId]);
      expect(orderRow.rows[0].status).toBe('requested');
      expect(orderRow.rows[0].supplier_actor_id).toBeNull();

      const exceptions = await pool.query(`select exception_code from case_exceptions where case_id=$1`, [caseId]);
      expect(exceptions.rows.some((r: { exception_code: string }) => r.exception_code === 'NO_ELIGIBLE_PARTS_SUPPLIER')).toBe(true);
    } finally {
      await setPartsPolicyActive(false);
    }
  });

  it('admin manual-trigger endpoint fails closed with policy_required when no policy is active', async () => {
    await setPartsPolicyActive(false);
    const { orderId } = await createOrder();
    const res = await app.inject({ method: 'POST', url: `/api/admin/parts-orders/${orderId}/auto-assign-supplier`, headers: adminHeaders() });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('policy_required');
  });
});
