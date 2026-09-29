import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { autoAssignPartsSupplier } from '../src/services/parts.js';

// A dealership's parts are its own. Other businesses see them only as far as the dealership's
// disclosure policy allows, and Core sources them for someone else's job only under an explicit
// transfer permission (Master Technical Specification v2.3, "Parts as First-Class Capacity").

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const admin = () => ({ 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY });
const as = (role: string, actorId: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actorId });

describe('dealership inventory disclosure and transfer permissions', () => {
  let app: FastifyInstance;
  let dealerA: string; // holds the part
  let dealerB: string; // same dealer group as A
  let dealerC: string; // different group
  let supplier: string;
  let customer: string;
  const sku = `DLR-PART-${Date.now()}`;

  async function actor(actorType: string, orgId?: string) {
    const res = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin(), payload: { actorType, attributes: { displayName: `${actorType} ${Math.random().toString(36).slice(2, 6)}` } } });
    const id = JSON.parse(res.body).actor.id as string;
    if (orgId) await pool.query('update actors set organization_id=$2 where id=$1', [id, orgId]);
    return id;
  }

  async function org(name: string) {
    return (await pool.query(`insert into organizations(organization_type,display_name,status) values('repair_partner',$1,'active') returning id`, [name])).rows[0].id as string;
  }

  async function search(viewer: string, role = 'partner', quantity = 1) {
    const res = await app.inject({ method: 'GET', url: `/api/network/parts?sku=${sku}&quantity=${quantity}`, headers: as(role, viewer) });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).matches as { ownerActorId: string; sourceType: string; available: boolean; quantityAvailable: number | null; canRequestTransfer: boolean }[];
  }

  const findA = (matches: Awaited<ReturnType<typeof search>>) => matches.find((m) => m.ownerActorId === dealerA);

  async function setPolicy(owner: string, visibility: string, detail = 'availability_only') {
    const res = await app.inject({ method: 'PUT', url: '/api/partners/me/inventory-policies/parts', headers: as('partner', owner), payload: { visibility, detail } });
    expect(res.statusCode).toBe(200);
  }

  async function grant(grantor: string, grantee: string, body: Record<string, unknown>) {
    return app.inject({ method: 'PUT', url: `/api/partners/me/transfer-permissions/${grantee}/parts`, headers: as('partner', grantor), payload: body });
  }

  /** A case whose repair is being performed by `repairer`, with a parts order for the dealer-only SKU. */
  async function orderFor(repairer: string, partSku = sku) {
    const demand = await app.inject({ method: 'POST', url: '/api/demands', headers: as('customer', customer), payload: { domain: 'maintenance', demandType: 'brake_repair' } });
    const caseId = JSON.parse(demand.body).case.id as string;
    for (const toState of ['provider_selection', 'provider_pending', 'repair_in_progress']) {
      await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: admin(), payload: { toState } });
    }
    await pool.query('update service_cases set selected_actor_id=$2 where id=$1', [caseId, repairer]);
    const order = await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/parts-orders`, headers: admin(), payload: { items: [{ sku: partSku, quantity: 1 }] } });
    return JSON.parse(order.body).order.id as string;
  }

  beforeAll(async () => {
    app = await buildApp();
    const groupX = await org('Group X Motors');
    const groupY = await org('Group Y Auto');
    dealerA = await actor('partner', groupX);
    dealerB = await actor('partner', groupX);
    dealerC = await actor('partner', groupY);
    supplier = await actor('parts');
    customer = await actor('customer');
    const stocked = await app.inject({ method: 'PUT', url: '/api/parts/inventory', headers: as('partner', dealerA), payload: { sku, quantityOnHand: 3, unitPrice: 40 } });
    expect(stocked.statusCode).toBe(200);
    await pool.query(
      `insert into routing_policies(domain_id, policy_key, version, active, configuration)
       select id, 'parts_supplier_default', 1, true, '{"weights":{"price":-1},"defaults":{"price":0}}'::jsonb from domains where code='maintenance'
       on conflict (domain_id, policy_key, version) do update set active=true, configuration=excluded.configuration, updated_at=now()`
    );
  });

  afterAll(async () => {
    await pool.query(`update routing_policies set active=false where policy_key='parts_supplier_default'`);
    await pool.end();
  });

  describe('visibility', () => {
    it('keeps a dealership\'s stock invisible by default, while dedicated suppliers stay visible', async () => {
      await app.inject({ method: 'PUT', url: '/api/parts/inventory', headers: as('parts', supplier), payload: { sku, quantityOnHand: 10, unitPrice: 55 } });
      for (const viewer of [dealerB, dealerC]) {
        const matches = await search(viewer);
        expect(findA(matches)).toBeUndefined();
        expect(matches.find((m) => m.ownerActorId === supplier)).toMatchObject({ sourceType: 'supplier', available: true, quantityAvailable: 10 });
      }
      const policy = await app.inject({ method: 'GET', url: '/api/partners/me/inventory-policies', headers: as('partner', dealerA) });
      expect(JSON.parse(policy.body).policies.parts.visibility).toBe('private');
      await pool.query('update parts_inventory set active=false where supplier_actor_id=$1', [supplier]);
    });

    it('same_organization shows availability to the dealer group only, and quantity only when disclosed', async () => {
      await setPolicy(dealerA, 'same_organization');
      expect(findA(await search(dealerB))).toMatchObject({ sourceType: 'dealership', available: true, quantityAvailable: null, canRequestTransfer: false });
      expect(findA(await search(dealerB, 'partner', 5))).toMatchObject({ available: false, quantityAvailable: null });
      expect(findA(await search(dealerC))).toBeUndefined();
      await setPolicy(dealerA, 'same_organization', 'quantity');
      expect(findA(await search(dealerB))).toMatchObject({ quantityAvailable: 3 });
    });

    it('named_partners shows the stock only to partners the dealership named', async () => {
      await setPolicy(dealerA, 'named_partners');
      expect(findA(await search(dealerB))).toBeUndefined();
      expect((await grant(dealerA, dealerC, { canView: true })).statusCode).toBe(200);
      expect(findA(await search(dealerC))).toMatchObject({ available: true, canRequestTransfer: false });
      expect(findA(await search(dealerB))).toBeUndefined();
    });

    it('network shows it to every participant, including non-dealer roles', async () => {
      await setPolicy(dealerA, 'network');
      const tow = await actor('tow');
      expect(findA(await search(tow, 'tow'))).toBeDefined();
      expect(findA(await search(dealerB))).toBeDefined();
      await setPolicy(dealerA, 'private');
      expect(findA(await search(tow, 'tow'))).toBeUndefined();
    });

    it('never shows a dealership its own stock as a network match', async () => {
      await setPolicy(dealerA, 'network');
      expect(findA(await search(dealerA))).toBeUndefined();
      await setPolicy(dealerA, 'private');
    });
  });

  describe('automatic sourcing', () => {
    it('does not commit a dealership\'s stock to another business\'s job without a transfer permission, even when visible', async () => {
      await setPolicy(dealerA, 'network');
      const orderId = await orderFor(dealerB);
      const outcome = await autoAssignPartsSupplier({ role: 'admin' }, orderId);
      expect(outcome.result).toBeNull();
      const row = await pool.query('select supplier_actor_id from parts_orders where id=$1', [orderId]);
      expect(row.rows[0].supplier_actor_id).toBeNull();
    });

    it('sources it once the dealership grants that business transfer rights, and stops when revoked', async () => {
      expect((await grant(dealerA, dealerB, { canView: true, canRequestTransfer: true })).statusCode).toBe(200);
      const first = await orderFor(dealerB);
      const assigned = await autoAssignPartsSupplier({ role: 'admin' }, first);
      expect(assigned.result?.order.supplier_actor_id).toBe(dealerA);

      const permissions = await app.inject({ method: 'GET', url: '/api/partners/me/transfer-permissions', headers: as('partner', dealerA) });
      expect(JSON.parse(permissions.body).permissions.some((p: { grantee_actor_id: string; can_request_transfer: boolean }) => p.grantee_actor_id === dealerB && p.can_request_transfer)).toBe(true);

      expect((await app.inject({ method: 'DELETE', url: `/api/partners/me/transfer-permissions/${dealerB}/parts`, headers: as('partner', dealerA) })).statusCode).toBe(200);
      const second = await orderFor(dealerB);
      expect((await autoAssignPartsSupplier({ role: 'admin' }, second)).result).toBeNull();
    });

    it('ignores an expired transfer permission', async () => {
      await grant(dealerA, dealerC, { canView: true, canRequestTransfer: true, expiresAt: new Date(Date.now() - 60_000).toISOString() });
      const orderId = await orderFor(dealerC);
      expect((await autoAssignPartsSupplier({ role: 'admin' }, orderId)).result).toBeNull();
    });

    it('always lets a dealership use its own stock for its own job, even when private', async () => {
      await setPolicy(dealerA, 'private');
      const orderId = await orderFor(dealerA);
      expect((await autoAssignPartsSupplier({ role: 'admin' }, orderId)).result?.order.supplier_actor_id).toBe(dealerA);
    });

    it('keeps dealership stock out of on-site field repair unless the operator was granted transfer rights', async () => {
      const operator = await actor('tow');
      await app.inject({ method: 'PUT', url: `/api/admin/field-service/actors/${operator}/capabilities`, headers: admin(), payload: { active: true, repairClasses: ['battery'] } });
      const demand = await app.inject({ method: 'POST', url: '/api/demands', headers: as('customer', customer), payload: { domain: 'maintenance', demandType: 'battery' } });
      const caseId = JSON.parse(demand.body).case.id as string;
      const assess = () => app.inject({
        method: 'POST', url: `/api/maintenance/cases/${caseId}/field-service/assess`, headers: admin(),
        payload: { operatorActorId: operator, summary: 'Battery swap on site', repairClass: 'battery', drivability: 'drivable', confidence: 0.9, requiredParts: [{ sku, quantity: 1 }] }
      });
      const blocked = JSON.parse((await assess()).body).decision;
      expect(blocked.action).toBe('dispatch_field_technician');
      await grant(dealerA, operator, { canRequestTransfer: true });
      const allowed = JSON.parse((await assess()).body).decision;
      expect(allowed.action).toBe('field_repair');
      expect(allowed.metadata.fulfillingSupplierActorId).toBe(dealerA);
    });
  });

  describe('who may change the rules', () => {
    it('only the owner (or an admin) sets a dealership\'s policy and grants', async () => {
      // dealerB's "me" endpoints only ever touch dealerB's own rules.
      await app.inject({ method: 'PUT', url: '/api/partners/me/inventory-policies/parts', headers: as('partner', dealerB), payload: { visibility: 'network' } });
      const aPolicy = await app.inject({ method: 'GET', url: `/api/admin/actors/${dealerA}/inventory-policies`, headers: admin() });
      expect(JSON.parse(aPolicy.body).policies.parts.visibility).toBe('private');

      expect((await app.inject({ method: 'PUT', url: '/api/partners/me/inventory-policies/parts', headers: as('tow', dealerB), payload: { visibility: 'network' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/api/admin/actors/${dealerA}/inventory-policies`, headers: as('partner', dealerB) })).statusCode).toBe(403);

      const byAdmin = await app.inject({ method: 'PUT', url: `/api/admin/actors/${dealerA}/transfer-permissions/${dealerC}/parts`, headers: admin(), payload: { canView: true } });
      expect(byAdmin.statusCode).toBe(200);
    });

    it('rejects self-grants, unknown partners, unknown resources and unknown actors', async () => {
      expect((await grant(dealerA, dealerA, {})).statusCode).toBe(400);
      expect((await grant(dealerA, '00000000-0000-4000-8000-00000000abcd', {})).statusCode).toBe(404);
      expect((await app.inject({ method: 'PUT', url: '/api/partners/me/inventory-policies/secrets', headers: as('partner', dealerA), payload: { visibility: 'network' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: '/api/admin/actors/00000000-0000-4000-8000-00000000abcd/inventory-policies/parts', headers: admin(), payload: { visibility: 'network' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PUT', url: '/api/admin/actors/not-a-uuid/inventory-policies/parts', headers: admin(), payload: { visibility: 'network' } })).statusCode).toBe(400);
    });

    it('records every change in the audit log', async () => {
      const rows = await pool.query(`select action from audit_log where object_id=$1 and action in ('set_inventory_disclosure','grant_transfer_permission','revoke_transfer_permission')`, [dealerA]);
      const actions = new Set(rows.rows.map((r) => r.action));
      expect(actions).toEqual(new Set(['set_inventory_disclosure', 'grant_transfer_permission', 'revoke_transfer_permission']));
    });
  });
});
