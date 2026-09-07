import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole, requireRoleOrCapability } from '../middleware/principal.js';
import { assignTransportDispatch, createTransportDispatch, getTransportDispatch, updateTransportStatus } from '../../services/transport.js';
import { resolveTransportLocations } from '../../services/transport-spatial.js';
import { assertAdminCaseScope, getAdminActorScope } from '../../services/admin-case-scope.js';

const location = z.record(z.unknown()).optional();
const status = z.enum(['accepted','en_route','arrived','vehicle_loaded','in_transit','delivered','declined','cancelled','failed']);
const MAX_LOCATION_FUTURE_SKEW_MS=2*60*1000;

const effectiveDispatchSelect = `
  select td.*,
    case when td.pickup_location='{}'::jsonb then
      coalesce(nullif(s.current_vehicle,'{}'::jsonb),nullif(s.origin,'{}'::jsonb),nullif(d.location,'{}'::jsonb),td.pickup_location)
      else td.pickup_location end as pickup_location,
    case when td.dropoff_location='{}'::jsonb then
      coalesce(nullif(s.destination,'{}'::jsonb),td.dropoff_location)
      else td.dropoff_location end as dropoff_location,
    case
      when coalesce(nullif(td.pickup_location,'{}'::jsonb),nullif(s.current_vehicle,'{}'::jsonb),nullif(s.origin,'{}'::jsonb),nullif(d.location,'{}'::jsonb)) is null then 'location_pending'
      when coalesce(nullif(td.dropoff_location,'{}'::jsonb),nullif(s.destination,'{}'::jsonb)) is null then 'pickup_ready'
      else 'ready'
    end as location_status
  from transport_dispatches td
  join service_cases c on c.id=td.case_id
  left join case_spatial_context s on s.case_id=td.case_id
  left join demand_requests d on d.id=c.demand_id`;

export async function transportRoutes(app: FastifyInstance) {
  app.get('/api/admin/transport', { preHandler: requireRole('admin') }, async (req) => {
    const query = z.object({ caseId:z.string().uuid().optional(), status:status.optional() }).parse(req.query ?? {});
    const scope = await getAdminActorScope(req.principal,pool);
    if (query.caseId) await assertAdminCaseScope(req.principal,query.caseId,pool);
    const params:unknown[]=[query.caseId ?? null,query.status ?? null];
    let scopeClause='';
    if(scope){
      params.push(scope.organizationId); const org=params.length;
      params.push(scope.locationId); const loc=params.length;
      scopeClause=` and exists(
        select 1 from service_cases sc
        left join actors owner on owner.id=sc.current_owner_actor_id
        left join actors selected on selected.id=sc.selected_actor_id
        left join actors recommended on recommended.id=sc.recommended_actor_id
        where sc.id=td.case_id and (
          (owner.organization_id=$${org} and ($${loc}::uuid is null or owner.location_id=$${loc}))
          or (selected.organization_id=$${org} and ($${loc}::uuid is null or selected.location_id=$${loc}))
          or (recommended.organization_id=$${org} and ($${loc}::uuid is null or recommended.location_id=$${loc}))
          or exists(
            select 1 from matches_offers mo join actors provider on provider.id=mo.actor_id
            where mo.case_id=sc.id and provider.organization_id=$${org}
              and ($${loc}::uuid is null or provider.location_id=$${loc})
          )
        )
      )`;
    }
    const r = await pool.query(
      `${effectiveDispatchSelect}
       where ($1::uuid is null or td.case_id=$1)
         and ($2::text is null or td.status=$2)
         ${scopeClause}
       order by td.created_at desc limit 200`,
      params
    );
    return { dispatches:r.rows };
  });

  app.post('/api/admin/transport', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ caseId:z.string().uuid(), transportType:z.enum(['tow','valet']), pickupLocation:location, dropoffLocation:location, vehicleContext:z.record(z.unknown()).optional(), etaAt:z.string().datetime().optional(), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try {
      await assertAdminCaseScope(req.principal,body.caseId,pool);
      const resolved = await resolveTransportLocations(body.caseId, body);
      return reply.code(201).send({
        dispatch:await createTransportDispatch(req.principal,{
          ...body,
          pickupLocation:resolved.pickupLocation,
          dropoffLocation:resolved.dropoffLocation,
          metadata:{
            ...(body.metadata ?? {}),
            locationStatus:resolved.locationStatus,
            pickupSource:resolved.pickupSource,
            dropoffSource:resolved.dropoffSource
          }
        })
      });
    }
    catch (e) { const message=e instanceof Error?e.message:'transport_create_failed'; if (message==='case_not_found') return reply.code(404).send({ error:message }); if (message==='invalid_case_transition') return reply.code(409).send({ error:message }); throw e; }
  });

  app.post('/api/admin/transport/:id/assign', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string }; const body = z.object({ providerActorId:z.string().uuid(), etaAt:z.string().datetime().optional() }).parse(req.body);
    try {
      const dispatch=await getTransportDispatch(id);
      if(!dispatch) return reply.code(404).send({error:'dispatch_not_found'});
      await assertAdminCaseScope(req.principal,dispatch.case_id,pool);
      return { dispatch:await assignTransportDispatch(req.principal,id,body.providerActorId,body.etaAt) };
    }
    catch (e) { const message=e instanceof Error?e.message:'transport_assign_failed'; if (['dispatch_not_found','provider_not_found'].includes(message)) return reply.code(404).send({ error:message }); if (['dispatch_not_assignable','provider_not_transport_capable'].includes(message)) return reply.code(409).send({ error:message }); throw e; }
  });

  app.get('/api/transport/me/dispatches', { preHandler: requireRoleOrCapability('tow','tow','partner') }, async (req) => {
    const r = await pool.query(`${effectiveDispatchSelect} where td.provider_actor_id=$1 order by td.created_at desc limit 200`, [req.principal.actorId]);
    return { dispatches:r.rows };
  });

  app.get('/api/transport/me/history', { preHandler: requireRoleOrCapability('tow','tow','partner') }, async (req) => {
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
    const { id } = req.params as { id:string };
    const base = await getTransportDispatch(id);
    if (!base) return reply.code(404).send({ error:'dispatch_not_found' });
    if(req.principal.role==='admin') await assertAdminCaseScope(req.principal,base.case_id,pool);
    else if(!req.principal.actorId||!base.provider_actor_id||base.provider_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'forbidden' });
    const projected = await pool.query(`${effectiveDispatchSelect} where td.id=$1`,[id]);
    return { dispatch:projected.rows[0] ?? base };
  });

  app.post('/api/transport/:id/location', { preHandler: requireRoleOrCapability('tow','tow','partner','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ lat:z.number().min(-90).max(90), lng:z.number().min(-180).max(180), accuracy:z.number().nonnegative().optional(), heading:z.number().min(0).max(360).nullable().optional(), speed:z.number().nonnegative().nullable().optional(), capturedAt:z.string().datetime().optional() }).parse(req.body);
    const d = await getTransportDispatch(id);
    if (!d) return reply.code(404).send({ error:'dispatch_not_found' });
    if(req.principal.role==='admin') await assertAdminCaseScope(req.principal,d.case_id,pool);
    else if(!req.principal.actorId||!d.provider_actor_id||d.provider_actor_id !== req.principal.actorId) return reply.code(403).send({ error:'dispatch_forbidden' });
    const receivedAtMs=Date.now();
    const rawCapturedAtMs=body.capturedAt?new Date(body.capturedAt).getTime():receivedAtMs;
    if(rawCapturedAtMs>receivedAtMs+MAX_LOCATION_FUTURE_SKEW_MS){
      return reply.code(400).send({error:'location_captured_at_future',maxFutureSkewSeconds:MAX_LOCATION_FUTURE_SKEW_MS/1000});
    }
    const capturedAt = new Date(rawCapturedAtMs).toISOString();
    const point = { lat:body.lat,lng:body.lng,accuracy:body.accuracy ?? null,heading:body.heading ?? null,speed:body.speed ?? null,capturedAt,capturedAtEpochMs:rawCapturedAtMs,receivedAt:new Date(receivedAtMs).toISOString(),dispatchId:id };
    const written = await pool.query(
      `insert into case_spatial_context(case_id,transport_location,source,updated_at)
       values($1,$2::jsonb,'tow_live_gps',now())
       on conflict(case_id) do update set transport_location=excluded.transport_location,source='tow_live_gps',updated_at=now()
       where case
         when jsonb_typeof(case_spatial_context.transport_location->'capturedAtEpochMs')='number'
           then (case_spatial_context.transport_location->>'capturedAtEpochMs')::numeric < (excluded.transport_location->>'capturedAtEpochMs')::numeric
         when case_spatial_context.transport_location->>'capturedAt' is null
           then true
         when case_spatial_context.transport_location->>'capturedAt' !~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'
           then true
         else (case_spatial_context.transport_location->>'capturedAt') < (excluded.transport_location->>'capturedAt')
       end
       returning transport_location`,
      [d.case_id,JSON.stringify(point)]
    );
    if(written.rowCount) return { ok:true,accepted:true,transportLocation:written.rows[0].transport_location };
    const current=await pool.query(`select transport_location from case_spatial_context where case_id=$1`,[d.case_id]);
    return { ok:true,accepted:false,transportLocation:current.rows[0]?.transport_location ?? point };
  });

  app.post('/api/transport/:id/status', { preHandler: requireRoleOrCapability('tow','tow','partner','admin') }, async (req, reply) => {
    const { id } = req.params as { id:string }; const body = z.object({ status, metadata:z.record(z.unknown()).optional() }).parse(req.body);
    try {
      const d=await getTransportDispatch(id);
      if(!d) return reply.code(404).send({error:'dispatch_not_found'});
      if(req.principal.role==='admin') await assertAdminCaseScope(req.principal,d.case_id,pool);
      else if(!req.principal.actorId||!d.provider_actor_id||d.provider_actor_id!==req.principal.actorId) return reply.code(403).send({error:'dispatch_forbidden'});
      return { dispatch:await updateTransportStatus(req.principal,id,body.status,body.metadata ?? {}) };
    }
    catch (e) {
      const message=e instanceof Error?e.message:'transport_update_failed';
      if (message==='dispatch_not_found') return reply.code(404).send({ error:message });
      if (message==='dispatch_forbidden') return reply.code(403).send({ error:message });
      if (['invalid_dispatch_transition','dropoff_location_required'].includes(message)) return reply.code(409).send({ error:message });
      throw e;
    }
  });
}