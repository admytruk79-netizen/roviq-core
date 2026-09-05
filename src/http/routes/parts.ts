import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { assignSupplier, createPartsOrder, getPartsOrder, markPartsOrderStatus, reserveOrderInventory, upsertInventory } from '../../services/parts.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';

export async function partsRoutes(app: FastifyInstance) {
  app.post('/api/maintenance/cases/:caseId/parts-orders', { preHandler: requireRole('partner','diagnostic','admin') }, async (req, reply) => {
    const { caseId } = req.params as { caseId:string };
    const body = z.object({
      deliveryLocationId:z.string().uuid().optional(),
      neededBy:z.string().datetime().optional(),
      items:z.array(z.object({ sku:z.string().min(1), partNumber:z.string().optional(), description:z.string().optional(), quantity:z.number().int().positive(), attributes:z.record(z.unknown()).optional() })).min(1),
      attributes:z.record(z.unknown()).optional()
    }).parse(req.body);
    try {
      const order = await createPartsOrder(req.principal,{ caseId,...body });
      return reply.code(201).send(order);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'parts_order_failed';
      if (message === 'case_not_found') return reply.code(404).send({ error:message });
      throw e;
    }
  });

  app.get('/api/admin/maintenance/cases/:caseId/parts-orders', { preHandler: requireRole('admin') }, async (req) => {
    const { caseId } = req.params as { caseId:string };
    const r = await pool.query(
      `select * from parts_orders where case_id=$1 order by created_at desc`,
      [caseId]
    );
    return { orders:r.rows };
  });

  app.get('/api/maintenance/parts-orders/:id', async (req, reply) => {
    const { id } = req.params as { id:string };
    const result = await getPartsOrder(id);
    if (!result) return reply.code(404).send({ error:'order_not_found' });
    const order:any = (result as any).order;
    try {
      // Route through the shared access service (also used by cases.ts/mobility.ts/payments.ts)
      // instead of a second, narrower ad hoc allow-list -- the previous version only recognized
      // the case's customer or this order's own assigned supplier, so e.g. a tow provider or
      // diagnostic actor with a real relation to the same case was wrongly denied.
      const c = await loadCaseForPrincipal(req.principal,order.case_id);
      if (!c) return reply.code(404).send({ error:'order_not_found' });
      return result;
    } catch (e) {
      if (e instanceof Error && e.message === 'forbidden') return reply.code(403).send({ error:'forbidden' });
      throw e;
    }
  });

  app.post('/api/admin/parts-orders/:id/assign-supplier', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ supplierActorId:z.string().uuid() }).parse(req.body);
    try { return { order:await assignSupplier(req.principal,id,body.supplierActorId) }; }
    catch (e) {
      const message = e instanceof Error ? e.message : 'assignment_failed';
      if (message === 'supplier_not_available' || message === 'invalid_supplier_type') return reply.code(400).send({ error:message });
      if (message === 'order_not_assignable') return reply.code(409).send({ error:message });
      throw e;
    }
  });

  app.post('/api/parts/orders/:id/reserve', { preHandler: requireRole('parts','partner','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    try { return { order:await reserveOrderInventory(req.principal,id) }; }
    catch (e) {
      const message = e instanceof Error ? e.message : 'reserve_failed';
      if (message === 'forbidden') return reply.code(403).send({ error:message });
      if (message === 'order_not_found') return reply.code(404).send({ error:message });
      if (message === 'supplier_not_assigned' || message === 'order_not_reservable' || message.startsWith('inventory_unavailable:')) return reply.code(409).send({ error:message });
      throw e;
    }
  });

  app.post('/api/parts/orders/:id/status', { preHandler: requireRole('parts','partner','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string }; const body = z.object({ status:z.enum(['ordered','shipped','delivered','cancelled','failed']), trackingReference:z.string().optional(), externalOrderReference:z.string().optional() }).parse(req.body);
    try { return { order:await markPartsOrderStatus(req.principal,id,body.status,body) }; }
    catch (e) {
      const message = e instanceof Error ? e.message : 'parts_transition_failed';
      if (message === 'forbidden') return reply.code(403).send({ error:message });
      if (message === 'order_not_found') return reply.code(404).send({ error:message });
      if (message === 'invalid_parts_transition') return reply.code(409).send({ error:message });
      throw e;
    }
  });

  app.put('/api/parts/inventory', { preHandler: requireRole('parts','partner','admin') }, async (req, reply) => {
    const body = z.object({ supplierActorId:z.string().uuid().optional(), sku:z.string().min(1), partNumber:z.string().optional(), description:z.string().optional(), quantityOnHand:z.number().int().nonnegative(), unitPrice:z.number().nonnegative().optional(), currency:z.string().length(3).optional(), locationId:z.string().uuid().optional(), attributes:z.record(z.unknown()).optional() }).parse(req.body);
    if (req.principal.role !== 'admin' && body.supplierActorId && body.supplierActorId !== req.principal.actorId) return reply.code(403).send({ error:'forbidden' });
    return { inventory:await upsertInventory(req.principal,body) };
  });

  app.get('/api/parts/me/orders', { preHandler: requireRole('parts','partner') }, async (req) => {
    const r = await pool.query(`select * from parts_orders where supplier_actor_id=$1 order by created_at desc limit 200`,[req.principal.actorId]);
    return { orders:r.rows };
  });
}
