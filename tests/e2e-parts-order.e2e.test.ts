import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const SKU = 'BRK-PAD-001';

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

describe('parts order end-to-end lifecycle', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let strangerCustomerId: string;
  let supplierActorId: string;
  let strangerSupplierId: string;
  let unrelatedTowActorId: string;

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const stranger = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    strangerCustomerId = JSON.parse(stranger.body).actor.id;

    const supplier = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    supplierActorId = JSON.parse(supplier.body).actor.id;

    const strangerSupplier = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'parts' } });
    strangerSupplierId = JSON.parse(strangerSupplier.body).actor.id;

    const unrelatedTow = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'tow' } });
    unrelatedTowActorId = JSON.parse(unrelatedTow.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('completes a full parts order vertical slice with enforced access and inventory conservation', async () => {
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id;

    for (const toState of ['provider_selection', 'provider_pending', 'repair_in_progress']) {
      const res = await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: adminHeaders(), payload: { toState } });
      expect(res.statusCode).toBe(200);
    }

    const orderRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/parts-orders`, headers: adminHeaders(),
      payload: { items: [{ sku: SKU, quantity: 2 }] }
    });
    expect(orderRes.statusCode).toBe(201);
    const created = JSON.parse(orderRes.body);
    expect(created.order.status).toBe('requested');
    expect(created.items.length).toBe(1);
    const orderId = created.order.id;

    // Creating the order while the case is repair_in_progress auto-transitions it to parts_pending.
    const casePendingRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    expect(JSON.parse(casePendingRes.body).case.state).toBe('parts_pending');

    // A non-supplier actor type cannot be assigned as a parts supplier.
    const invalidSupplierRes = await app.inject({
      method: 'POST', url: `/api/admin/parts-orders/${orderId}/assign-supplier`, headers: adminHeaders(),
      payload: { supplierActorId: customerActorId }
    });
    expect(invalidSupplierRes.statusCode).toBe(400);
    expect(JSON.parse(invalidSupplierRes.body).error).toBe('invalid_supplier_type');

    // Reserving before any inventory exists must fail with the specific missing-SKU error.
    const noInventoryAssignRes = await app.inject({
      method: 'POST', url: `/api/admin/parts-orders/${orderId}/assign-supplier`, headers: adminHeaders(),
      payload: { supplierActorId }
    });
    expect(noInventoryAssignRes.statusCode).toBe(200);
    const noInventoryReserveRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/reserve`, headers: actorHeaders('parts', supplierActorId)
    });
    expect(noInventoryReserveRes.statusCode).toBe(409);
    expect(JSON.parse(noInventoryReserveRes.body).error).toBe(`inventory_unavailable:${SKU}`);

    const inventoryRes = await app.inject({
      method: 'PUT', url: '/api/parts/inventory', headers: actorHeaders('parts', supplierActorId),
      payload: { sku: SKU, quantityOnHand: 5, unitPrice: 49.99 }
    });
    expect(inventoryRes.statusCode).toBe(200);

    // A supplier not assigned to this order cannot reserve it.
    const strangerReserveRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/reserve`, headers: actorHeaders('parts', strangerSupplierId)
    });
    expect(strangerReserveRes.statusCode).toBe(403);
    expect(JSON.parse(strangerReserveRes.body).error).toBe('forbidden');

    const reserveRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/reserve`, headers: actorHeaders('parts', supplierActorId)
    });
    expect(reserveRes.statusCode).toBe(200);
    expect(JSON.parse(reserveRes.body).order.order.status).toBe('reserved');

    const reservedInventory = await pool.query('select quantity_on_hand,quantity_reserved from parts_inventory where supplier_actor_id=$1 and sku=$2', [supplierActorId, SKU]);
    expect(reservedInventory.rows[0].quantity_reserved).toBe(2);
    expect(reservedInventory.rows[0].quantity_on_hand).toBe(5);

    // Skipping straight from 'reserved' to 'shipped' is an invalid transition.
    const invalidSkipRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/status`, headers: actorHeaders('parts', supplierActorId),
      payload: { status: 'shipped' }
    });
    expect(invalidSkipRes.statusCode).toBe(409);
    expect(JSON.parse(invalidSkipRes.body).error).toBe('invalid_parts_transition');

    // A supplier not assigned to this order cannot update its status either.
    const strangerStatusRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${orderId}/status`, headers: actorHeaders('parts', strangerSupplierId),
      payload: { status: 'ordered' }
    });
    expect(strangerStatusRes.statusCode).toBe(403);

    for (const status of ['ordered', 'shipped', 'delivered']) {
      const res = await app.inject({
        method: 'POST', url: `/api/parts/orders/${orderId}/status`, headers: actorHeaders('parts', supplierActorId),
        payload: { status }
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).order.status).toBe(status);
    }

    // Delivery decrements on-hand stock and releases the reservation, and resumes the repair.
    const finalInventory = await pool.query('select quantity_on_hand,quantity_reserved from parts_inventory where supplier_actor_id=$1 and sku=$2', [supplierActorId, SKU]);
    expect(finalInventory.rows[0].quantity_on_hand).toBe(3);
    expect(finalInventory.rows[0].quantity_reserved).toBe(0);

    const caseResumedRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}`, headers: adminHeaders() });
    expect(JSON.parse(caseResumedRes.body).case.state).toBe('repair_in_progress');

    // Access control on the order detail endpoint.
    const forbiddenCustomerRes = await app.inject({ method: 'GET', url: `/api/maintenance/parts-orders/${orderId}`, headers: actorHeaders('customer', strangerCustomerId) });
    expect(forbiddenCustomerRes.statusCode).toBe(403);
    const forbiddenSupplierRes = await app.inject({ method: 'GET', url: `/api/maintenance/parts-orders/${orderId}`, headers: actorHeaders('parts', strangerSupplierId) });
    expect(forbiddenSupplierRes.statusCode).toBe(403);
    // A role with no relation to this order at all (not the customer, not the assigned supplier)
    // must be denied too -- the previous if/else-if only rejected 'customer' and 'parts'
    // mismatches, so every other role fell through unchecked.
    const forbiddenUnrelatedRoleRes = await app.inject({ method: 'GET', url: `/api/maintenance/parts-orders/${orderId}`, headers: actorHeaders('tow', unrelatedTowActorId) });
    expect(forbiddenUnrelatedRoleRes.statusCode).toBe(403);
    const ownerRes = await app.inject({ method: 'GET', url: `/api/maintenance/parts-orders/${orderId}`, headers: actorHeaders('customer', customerActorId) });
    expect(ownerRes.statusCode).toBe(200);
    expect(JSON.parse(ownerRes.body).order.status).toBe('delivered');

    const meOrdersRes = await app.inject({ method: 'GET', url: '/api/parts/me/orders', headers: actorHeaders('parts', supplierActorId) });
    expect(meOrdersRes.statusCode).toBe(200);
    expect(JSON.parse(meOrdersRes.body).orders.some((o: { id: string }) => o.id === orderId)).toBe(true);

    // A second order, reserved then cancelled, must release its reservation back to inventory.
    const secondOrderRes = await app.inject({
      method: 'POST', url: `/api/maintenance/cases/${caseId}/parts-orders`, headers: adminHeaders(),
      payload: { items: [{ sku: SKU, quantity: 1 }] }
    });
    const secondOrderId = JSON.parse(secondOrderRes.body).order.id;
    await app.inject({ method: 'POST', url: `/api/admin/parts-orders/${secondOrderId}/assign-supplier`, headers: adminHeaders(), payload: { supplierActorId } });
    await app.inject({ method: 'POST', url: `/api/parts/orders/${secondOrderId}/reserve`, headers: actorHeaders('parts', supplierActorId) });
    const cancelRes = await app.inject({
      method: 'POST', url: `/api/parts/orders/${secondOrderId}/status`, headers: actorHeaders('parts', supplierActorId),
      payload: { status: 'cancelled' }
    });
    expect(cancelRes.statusCode).toBe(200);
    const afterCancelInventory = await pool.query('select quantity_reserved from parts_inventory where supplier_actor_id=$1 and sku=$2', [supplierActorId, SKU]);
    expect(afterCancelInventory.rows[0].quantity_reserved).toBe(0);

    const timelineRes = await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/timeline`, headers: adminHeaders() });
    const timelineEvents = JSON.parse(timelineRes.body).timeline.map((e: { event_type: string }) => e.event_type);
    expect(timelineEvents).toEqual(expect.arrayContaining([
      'PARTS_ORDER_CREATED', 'CASE_PARTS_PENDING', 'PARTS_SUPPLIER_ASSIGNED', 'PARTS_RESERVED',
      'PARTS_ORDERED', 'PARTS_SHIPPED', 'PARTS_DELIVERED', 'CASE_REPAIR_IN_PROGRESS', 'PARTS_CANCELLED'
    ]));
  });
});
