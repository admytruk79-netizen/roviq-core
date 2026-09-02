import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { assignTransportDispatch, createTransportDispatch, getTransportDispatch, updateTransportStatus } from '../../services/transport.js';

const location = z.record(z.unknown()).optional();
const status = z.enum(['accepted','en_route','arrived','vehicle_loaded','in_transit','delivered','declined','cancelled','failed']);

export async function transportRoutes(app: FastifyInstance) {
  app.get('/api/admin/transport', { preHandler: requireRole('admin') }, async (req) => {
    const query = z.object({ caseId:z.string().uuid().optional(), status:status.optional() }).parse(req.query ?? {});
    const r = await pool.query(
      `select * from transport_dispatches
       where ($1::uuid is null or case_id=$1)
         and ($2::text is null or status=$2)
       order by created_at desc limit 200`,
      [query.caseId ?? null, query.status ?? null]
    );
    return { dispatches:r.rows };
  });

  app.post('/api/admin/transport', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ caseId:z.string().uuid(), transportType:z.enum(['tow','valet']), pickupLocation:location, dropoffLocation:location, vehicleContext:z.record(z.unknown()).optional(), etaAt:z.string().datetime().optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try { return reply.code(201).send({ dispatch:await createTransportDispatch(req.principal,body) }); }
    catch (e) { const message=e instanceof Error?e.message:'transport_create_failed'; if (message==='case_not_found') return reply.code(404).send({ error:message }); if (message==='invalid_case_transition') return reply.code(409).send({ error:message }); throw e; }
  });

  app.post('/api/admin/transport/:id/assign', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string }; const body = z.object({ providerActorId:z.string().uuid(), etaAt:z.string().datetime().optional() }).parse(req.body);
    try { return { dispatch:await assignTransportDispatch(req.principal,id,body.providerActorId,body.etaAt) }; }
    catch (e) { const message=e instanceof Error?e.message:'transport_assign_failed'; if (['dispatch_not_found','provider_not_found'].includes(message)) return reply.code(404).send({ error:message }); if (['dispatch_not_assignable','provider_not_transport_capable'].includes(message)) return reply.code(409).send({ error:message }); throw e; }
  });

  app.get('/api/transport/me/dispatches', { preHandler: requireRole('tow','partner') }, async (req) => {
    const r = await pool.query(`select * from transport_dispatches where provider_actor_id=$1 order by created_at desc limit 200`, [req.principal.actorId]);
    return { dispatches:r.rows };
  });

  app.get('/api/transport/me/history', { preHandler: requireRole('tow','partner') }, async (req) => {
    const r = await pool.query(
      `select distinct on (td.id)
         td.*,
         case
           when td.provider_actor_id=$1 and td.status in ('delivered','cancelled','failed') then td.status
           when decline.occurred_at is not null then 'declined'
           else td.status
         end as status,
         coalesce(decline.occurred_at,td.completed_at,td.updated_at) as history_at
       from transport_dispatches td
       left join lateral (
         select a.occurred_at
         from audit_log a
         where a.object_type='transport_dispatch'
           and a.object_id=td.id::text
           and a.principal_actor_id=$1
           and a.action='update_transport_status'
           and a.rule_basis like '%declined%'
         order by a.occurred_at desc
         limit 1
       ) decline on true
       where (td.provider_actor_id=$1 and td.status in ('delivered','cancelled','failed'))
          or decline.occurred_at is not null
       order by td.id, coalesce(decline.occurred_at,td.completed_at,td.updated_at) desc`,
      [req.principal.actorId]
    );
    const history = [...r.rows].sort((a,b)=>new Date(b.history_at ?? b.updated_at ?? 0).getTime()-new Date(a.history_at ?? a.updated_at ?? 0).getTime()).slice(0,200);
    return { dispatches:history };
  });

  app.get('/api/transport/:id', async (req, reply) => {
    const { id } = req.params as { id:string }; const d = await getTransportDispatch(id); if (!d) return reply.code(404).send({ error:'dispatch_not_found' }); if (req.principal.role !== 'admin' && d.provider_actor_id && d.provider_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'forbidden' }); return { dispatch:d };
  });

  app.post('/api/transport/:id/location', { preHandler: requireRole('tow','partner','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ lat:z.number().min(-90).max(90), lng:z.number().min(-180).max(180), accuracy:z.number().nonnegative().optional(), heading:z.number().min(0).max(360).nullable().optional(), speed:z.number().nonnegative().nullable().optional(), capturedAt:z.string().datetime().optional() }).parse(req.body);
    const d = await getTransportDispatch(id);
    if (!d) return reply.code(404).send({ error:'dispatch_not_found' });
    if (req.principal.role !== 'admin' && d.provider_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'dispatch_forbidden' });
    const point = { lat:body.lat,lng:body.lng,accuracy:body.accuracy ?? null,heading:body.heading ?? null,speed:body.speed ?? null,capturedAt:body.capturedAt ?? new Date().toISOString(),dispatchId:id };
    await pool.query(
      `insert into case_spatial_context(case_id,transport_location,source,updated_at)
       values($1,$2::jsonb,'tow_live_gps',now())
       on conflict(case_id) do update set transport_location=excluded.transport_location,source='tow_live_gps',updated_at=now()`,
      [d.case_id,JSON.stringify(point)]
    );
    return { ok:true, transportLocation:point };
  });

  app.post('/api/transport/:id/status', { preHandler: requireRole('tow','partner','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string }; const body = z.object({ status, metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try { return { dispatch:await updateTransportStatus(req.principal,id,body.status,body.metadata ?? {}) }; }
    catch (e) {
      const message=e instanceof Error?e.message:'transport_update_failed';
      if (message==='dispatch_not_found') return reply.code(404).send({ error:message });
      if (message==='dispatch_forbidden') return reply.code(403).send({ error:message });
      if (['invalid_dispatch_transition','dropoff_location_required'].includes(message)) return reply.code(409).send({ error:message });
      throw e;
    }
  });
}
