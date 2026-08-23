import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { assignTransportDispatch, createTransportDispatch, getTransportDispatch, updateTransportStatus } from '../../services/transport.js';

const location = z.record(z.unknown()).optional();
const status = z.enum(['accepted','en_route','arrived','vehicle_loaded','in_transit','delivered','declined','cancelled','failed']);

export async function transportRoutes(app: FastifyInstance) {
  app.post('/api/admin/transport', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({
      caseId:z.string().uuid(),
      transportType:z.enum(['tow','valet']),
      pickupLocation:location,
      dropoffLocation:location,
      vehicleContext:z.record(z.unknown()).optional(),
      etaAt:z.string().datetime().optional(),
      metadata:z.record(z.unknown()).optional()
    }).parse(req.body);
    try {
      return reply.code(201).send({ dispatch:await createTransportDispatch(req.principal,body) });
    } catch (e) {
      const message=e instanceof Error?e.message:'transport_create_failed';
      if (message==='case_not_found') return reply.code(404).send({ error:message });
      if (message==='invalid_case_transition') return reply.code(409).send({ error:message });
      throw e;
    }
  });

  app.post('/api/admin/transport/:id/assign', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ providerActorId:z.string().uuid(), etaAt:z.string().datetime().optional() }).parse(req.body);
    try {
      return { dispatch:await assignTransportDispatch(req.principal,id,body.providerActorId,body.etaAt) };
    } catch (e) {
      const message=e instanceof Error?e.message:'transport_assign_failed';
      if (['dispatch_not_found','provider_not_found'].includes(message)) return reply.code(404).send({ error:message });
      if (['dispatch_not_assignable','provider_not_transport_capable'].includes(message)) return reply.code(409).send({ error:message });
      throw e;
    }
  });

  app.get('/api/transport/:id', async (req, reply) => {
    const { id } = req.params as { id:string };
    const d = await getTransportDispatch(id);
    if (!d) return reply.code(404).send({ error:'dispatch_not_found' });
    if (req.principal.role !== 'admin' && d.provider_actor_id && d.provider_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'forbidden' });
    return { dispatch:d };
  });

  app.post('/api/transport/:id/status', { preHandler: requireRole('tow','partner','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ status, metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try {
      return { dispatch:await updateTransportStatus(req.principal,id,body.status,body.metadata ?? {}) };
    } catch (e) {
      const message=e instanceof Error?e.message:'transport_update_failed';
      if (message==='dispatch_not_found') return reply.code(404).send({ error:message });
      if (message==='dispatch_forbidden') return reply.code(403).send({ error:message });
      if (message==='invalid_dispatch_transition') return reply.code(409).send({ error:message });
      throw e;
    }
  });
}
