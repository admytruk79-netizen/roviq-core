import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';
import { requireRole } from '../middleware/principal.js';

const partnerSubtype = z.enum(['dealership','independent_repair','service_center','mobile_service']);

export async function coherenceRoutes(app: FastifyInstance) {
  app.get('/api/maintenance/cases/:id/spatial', async (req, reply) => {
    const { id } = req.params as { id:string };
    try {
      const c = await loadCaseForPrincipal(req.principal,id);
      if (!c) return reply.code(404).send({ error:'case_not_found' });
      const r = await pool.query('select * from case_spatial_context where case_id=$1',[id]);
      const spatial = r.rows[0] ?? { case_id:id, route_context:{} };
      return { spatial:projectSpatial(req.principal.role,spatial) };
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden') return reply.code(403).send({error:'forbidden'});
      throw error;
    }
  });

  app.get('/api/admin/spatial/network', { preHandler: requireRole('admin') }, async () => {
    const r = await pool.query(`
      select c.id as case_id,c.state,c.priority,c.drivability,c.updated_at,
             s.origin,s.current_vehicle,s.destination,s.diagnostic_location,s.provider_location,
             s.transport_location,s.parts_origin,s.route_context,s.source,s.updated_at as spatial_updated_at
      from service_cases c
      left join case_spatial_context s on s.case_id=c.id
      where c.state not in ('completed','cancelled')
      order by case when c.priority='urgent' then 0 when c.priority='high' then 1 else 2 end,c.updated_at desc
      limit 250
    `);
    return { cases:r.rows };
  });

  app.put('/api/admin/cases/:id/spatial', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id:string };
    const body = z.object({
      origin:z.record(z.unknown()).nullable().optional(),
      currentVehicle:z.record(z.unknown()).nullable().optional(),
      destination:z.record(z.unknown()).nullable().optional(),
      diagnosticLocation:z.record(z.unknown()).nullable().optional(),
      providerLocation:z.record(z.unknown()).nullable().optional(),
      transportLocation:z.record(z.unknown()).nullable().optional(),
      partsOrigin:z.record(z.unknown()).nullable().optional(),
      routeContext:z.record(z.unknown()).optional(),
      source:z.string().min(1).default('core')
    }).parse(req.body);
    const r = await pool.query(
      `insert into case_spatial_context(case_id,origin,current_vehicle,destination,diagnostic_location,provider_location,transport_location,parts_origin,route_context,source,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       on conflict(case_id) do update set
        origin=coalesce(excluded.origin,case_spatial_context.origin),
        current_vehicle=coalesce(excluded.current_vehicle,case_spatial_context.current_vehicle),
        destination=coalesce(excluded.destination,case_spatial_context.destination),
        diagnostic_location=coalesce(excluded.diagnostic_location,case_spatial_context.diagnostic_location),
        provider_location=coalesce(excluded.provider_location,case_spatial_context.provider_location),
        transport_location=coalesce(excluded.transport_location,case_spatial_context.transport_location),
        parts_origin=coalesce(excluded.parts_origin,case_spatial_context.parts_origin),
        route_context=case_spatial_context.route_context || excluded.route_context,
        source=excluded.source,updated_at=now() returning *`,
      [id,json(body.origin),json(body.currentVehicle),json(body.destination),json(body.diagnosticLocation),json(body.providerLocation),json(body.transportLocation),json(body.partsOrigin),JSON.stringify(body.routeContext ?? {}),body.source]
    );
    await audit(req.principal,'update_case_spatial','service_case',id,'core_spatial_context');
    return { spatial:r.rows[0] };
  });

  app.get('/api/partners/me/profile', { preHandler: requireRole('partner') }, async (req) => {
    const r = await pool.query('select id,actor_type,partner_subtype,status,attributes from actors where id=$1',[req.principal.actorId]);
    return { partner:r.rows[0] ?? null };
  });

  app.patch('/api/partners/me/profile', { preHandler: requireRole('partner') }, async (req) => {
    const body = z.object({ subtype:partnerSubtype, attributes:z.record(z.unknown()).optional() }).parse(req.body);
    const r = await pool.query(
      `update actors set partner_subtype=$1,attributes=attributes || $2::jsonb where id=$3 returning id,actor_type,partner_subtype,status,attributes`,
      [body.subtype,JSON.stringify(body.attributes ?? {}),req.principal.actorId]
    );
    await audit(req.principal,'update_partner_profile','actor',req.principal.actorId!,'actor_owned_partner_context',{subtype:body.subtype});
    return { partner:r.rows[0] };
  });

  app.post('/api/admin/cases/:id/coordination-milestones', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ milestoneCode:z.string().min(1), billable:z.boolean().default(false), metadata:z.record(z.unknown()).optional() }).parse(req.body);
    const r = await pool.query(
      `insert into coordination_milestones(case_id,milestone_code,billable,metadata)
       values($1,$2,$3,$4) on conflict(case_id,milestone_code) do nothing returning *`,
      [id,body.milestoneCode,body.billable,JSON.stringify(body.metadata ?? {})]
    );
    if (!r.rowCount) return reply.code(409).send({error:'coordination_milestone_already_recorded'});
    if (body.billable) await pool.query(
      `update service_cases set coordination_completed_at=coalesce(coordination_completed_at,now()),coordination_completion_code=coalesce(coordination_completion_code,$1),updated_at=now() where id=$2`,
      [body.milestoneCode,id]
    );
    await audit(req.principal,'record_coordination_milestone','service_case',id,'explicit_coordination_milestone',{milestoneCode:body.milestoneCode,billable:body.billable});
    return reply.code(201).send({ milestone:r.rows[0] });
  });

  app.get('/api/admin/cases/:id/engine-trace', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id:string };
    const c = await pool.query('select * from service_cases where id=$1',[id]);
    if (!c.rowCount) return reply.code(404).send({error:'case_not_found'});
    const [ai,routing,spatial,milestones,selections] = await Promise.all([
      pool.query('select * from ai_triage_assessments where case_id=$1 order by created_at desc limit 5',[id]),
      c.rows[0].demand_id ? pool.query('select * from routing_decisions where demand_id=$1 order by evaluated_at desc limit 10',[c.rows[0].demand_id]) : Promise.resolve({rows:[]}),
      pool.query('select * from case_spatial_context where case_id=$1',[id]),
      pool.query('select * from coordination_milestones where case_id=$1 order by occurred_at asc',[id]),
      pool.query('select * from case_selections where case_id=$1 order by created_at asc',[id])
    ]);
    return { case:c.rows[0], ai:ai.rows, routing:routing.rows, spatial:spatial.rows[0] ?? null, selections:selections.rows, milestones:milestones.rows };
  });
}

// route_context.candidates is keyed by every eligible actor's id (see src/services/routing.ts),
// with each candidate's own distance/ETA — internal routing-engine state, not something one
// provider should see about its competitors. Only admins get the raw route_context.
function sanitizeRouteContext(routeContext: unknown) {
  if (!routeContext || typeof routeContext !== 'object') return routeContext;
  const { candidates: _candidates, ...rest } = routeContext as Record<string, unknown>;
  return rest;
}

function projectSpatial(role:string, s:Record<string,unknown>) {
  if (role === 'admin') return s;
  const base = { case_id:s.case_id, source:s.source, updated_at:s.updated_at };
  const route_context = sanitizeRouteContext(s.route_context);
  if (role === 'tow') return {...base,origin:s.origin,current_vehicle:s.current_vehicle,destination:s.destination,transport_location:s.transport_location,route_context};
  if (role === 'diagnostic') return {...base,origin:s.origin,current_vehicle:s.current_vehicle,diagnostic_location:s.diagnostic_location,route_context};
  if (role === 'partner') return {...base,origin:s.origin,current_vehicle:s.current_vehicle,provider_location:s.provider_location,destination:s.destination,route_context};
  if (role === 'parts') return {...base,parts_origin:s.parts_origin,destination:s.destination,route_context};
  return {...base,origin:s.origin,current_vehicle:s.current_vehicle,destination:s.destination,provider_location:s.provider_location,transport_location:s.transport_location,route_context};
}

function json(value:unknown) { return value === undefined ? null : JSON.stringify(value); }
