import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { assignMobility, createMobilityResource, listMobilityForCase, requestMobility, updateMobilityState } from '../../services/mobility.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';

export async function mobilityRoutes(app: FastifyInstance) {
  app.post('/api/admin/mobility/resources', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({
      actorId:z.string().uuid(),
      resourceType:z.enum(['loaner','rental','rideshare_credit','shuttle','valet_return','other']),
      externalReference:z.string().optional(), label:z.string().optional(), locationId:z.string().uuid().optional(),
      attributes:z.record(z.unknown()).optional(), availableFrom:z.string().datetime().optional(), availableUntil:z.string().datetime().optional()
    }).parse(req.body);
    return reply.code(201).send({ resource:await createMobilityResource(req.principal,body) });
  });

  app.get('/api/mobility/resources/available', async (req) => {
    const q = z.object({ type:z.string().optional(), providerActorId:z.string().uuid().optional() }).parse(req.query ?? {});
    const params:any[]=[];
    const where=["status='available'",'(available_from is null or available_from<=now())','(available_until is null or available_until>now())'];
    if (q.type) { params.push(q.type); where.push(`resource_type=$${params.length}`); }
    if (q.providerActorId) { params.push(q.providerActorId); where.push(`actor_id=$${params.length}`); }
    const r = await pool.query(`select * from mobility_resources where ${where.join(' and ')} order by created_at asc limit 100`,params);
    return { resources:r.rows };
  });

  app.post('/api/maintenance/cases/:id/mobility', { preHandler: requireRole('customer','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ allocationType:z.enum(['loaner','rental','rideshare_credit','shuttle','valet_return','other']), notes:z.string().optional(), returnDueAt:z.string().datetime().optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try {
      const allocation = await requestMobility(req.principal,id,body);
      if (!allocation) return reply.code(404).send({ error:'case_not_found' });
      return reply.code(201).send({ allocation });
    } catch (e) {
      if (e instanceof Error && e.message === 'forbidden') return reply.code(403).send({ error:'forbidden' });
      throw e;
    }
  });

  app.get('/api/maintenance/cases/:id/mobility', async (req, reply) => {
    const { id } = req.params as { id:string };
    try {
      // The previous check only ever tested the 'customer' role -- every other role fell
      // through unchecked and could read any case's mobility allocations by id alone. Route
      // through the shared access service (also used by cases.ts/coherence.ts) instead of a
      // second, incomplete ad hoc check.
      const c = await loadCaseForPrincipal(req.principal,id);
      if (!c) return reply.code(404).send({ error:'case_not_found' });
      return { allocations:await listMobilityForCase(id) };
    } catch (e) {
      if (e instanceof Error && e.message === 'forbidden') return reply.code(403).send({ error:'forbidden' });
      throw e;
    }
  });

  app.post('/api/admin/mobility/:id/assign', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ providerActorId:z.string().uuid(), resourceId:z.string().uuid().optional(), returnDueAt:z.string().datetime().optional() }).parse(req.body);
    try {
      const allocation = await assignMobility(req.principal,id,body);
      if (!allocation) return reply.code(404).send({ error:'allocation_not_found' });
      return { allocation };
    } catch (e) {
      const m=e instanceof Error?e.message:'assignment_failed';
      if (['resource_not_found'].includes(m)) return reply.code(404).send({ error:m });
      if (['resource_provider_mismatch','resource_unavailable','invalid_allocation_state'].includes(m)) return reply.code(409).send({ error:m });
      throw e;
    }
  });

  app.post('/api/mobility/:id/state', { preHandler: requireRole('admin','fleet','partner') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ state:z.enum(['active','return_pending','completed','declined','cancelled','failed']) }).parse(req.body);
    const a = await pool.query('select provider_actor_id from mobility_allocations where id=$1',[id]);
    if (!a.rowCount) return reply.code(404).send({ error:'allocation_not_found' });
    if (req.principal.role !== 'admin' && a.rows[0].provider_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'forbidden' });
    try {
      const allocation = await updateMobilityState(req.principal,id,body.state);
      return { allocation };
    } catch (e) {
      if (e instanceof Error && e.message === 'invalid_allocation_transition') return reply.code(409).send({ error:e.message });
      throw e;
    }
  });

  app.get('/api/mobility/me/allocations', { preHandler: requireRole('fleet','partner') }, async (req) => {
    const r = await pool.query(`select * from mobility_allocations where provider_actor_id=$1 and state in ('assigned','active','return_pending') order by updated_at asc`,[req.principal.actorId]);
    return { allocations:r.rows };
  });
}
