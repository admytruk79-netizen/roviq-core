import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { loadCaseForPrincipal } from '../../services/case-access.js';
import { requireRole } from '../middleware/principal.js';

const selectionMode = z.enum(['customer_choice','dealer_controlled','auto_dispatch','ops_override']);
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

  app.post('/api/maintenance/cases/:id/select-provider', async (req, reply) => {
    const { id } = req.params as { id:string };
    const body = z.object({ actorId:z.string().uuid(), routingDecisionId:z.string().uuid().optional() }).parse(req.body);
    const c = await loadCaseForPrincipal(req.principal,id);
    if (!c) return reply.code(404).send({error:'case_not_found'});
    const mode = selectionMode.parse(c.selection_mode ?? 'customer_choice');
    if (!canSelect(req.principal.role,mode)) return reply.code(403).send({error:'selection_forbidden'});
    if (c.state !== 'provider_selection') return reply.code(409).send({error:'case_not_awaiting_provider_selection'});

    const decision = await pool.query(
      body.routingDecisionId
        ? `select * from routing_decisions where id=$1 and demand_id=$2 order by evaluated_at desc limit 1`
        : `select * from routing_decisions where demand_id=$1 order by evaluated_at desc limit 1`,
      body.routingDecisionId ? [body.routingDecisionId,c.demand_id] : [c.demand_id]
    );
    if (!decision.rowCount) return reply.code(409).send({error:'routing_decision_required'});
    const eligible = Array.isArray(decision.rows[0].eligible_actor_ids) ? decision.rows[0].eligible_actor_ids : [];
    if (!eligible.includes(body.actorId)) return reply.code(409).send({error:'actor_not_eligible'});

    const offer = await pool.query(
      `insert into matches_offers(demand_id,case_id,actor_id,score,rank,rule_basis)
       values($1,$2,$3,null,null,$4) returning *`,
      [c.demand_id,id,body.actorId,`governed_selection:${mode}`]
    );
    const updated = await pool.query(
      `update service_cases set selected_actor_id=$1,selected_by_role=$2,selected_at=now(),updated_at=now() where id=$3 returning *`,
      [body.actorId,req.principal.role,id]
    );
    await pool.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('service_case',$1,'PROVIDER_SELECTED',$2,$3)`,
      [id,req.principal.actorId ?? null,JSON.stringify({actorId:body.actorId,selectionMode:mode,offerId:offer.rows[0].id,routingDecisionId:decision.rows[0].id})]
    );
    await audit(req.principal,'select_provider','service_case',id,`selection_mode:${mode}`,{actorId:body.actorId,routingDecisionId:decision.rows[0].id});
    return { case:updated.rows[0], offer:offer.rows[0], selectionMode:mode };
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
    const [ai,routing,spatial,milestones] = await Promise.all([
      pool.query('select * from ai_triage_assessments where case_id=$1 order by created_at desc limit 5',[id]),
      c.rows[0].demand_id ? pool.query('select * from routing_decisions where demand_id=$1 order by evaluated_at desc limit 10',[c.rows[0].demand_id]) : Promise.resolve({rows:[]}),
      pool.query('select * from case_spatial_context where case_id=$1',[id]),
      pool.query('select * from coordination_milestones where case_id=$1 order by occurred_at asc',[id])
    ]);
    return { case:c.rows[0], ai:ai.rows, routing:routing.rows, spatial:spatial.rows[0] ?? null, milestones:milestones.rows };
  });
}

function canSelect(role:string, mode:z.infer<typeof selectionMode>) {
  if (role === 'admin') return true;
  return mode === 'customer_choice' && role === 'customer';
}

function projectSpatial(role:string, s:Record<string,unknown>) {
  if (role === 'admin') return s;
  const base = { case_id:s.case_id, source:s.source, updated_at:s.updated_at };
  if (role === 'tow') return {...base,origin:s.origin,current_vehicle:s.current_vehicle,destination:s.destination,transport_location:s.transport_location,route_context:s.route_context};
  if (role === 'diagnostic') return {...base,origin:s.origin,current_vehicle:s.current_vehicle,diagnostic_location:s.diagnostic_location,route_context:s.route_context};
  if (role === 'partner') return {...base,origin:s.origin,current_vehicle:s.current_vehicle,provider_location:s.provider_location,destination:s.destination,route_context:s.route_context};
  if (role === 'parts') return {...base,parts_origin:s.parts_origin,destination:s.destination,route_context:s.route_context};
  return {...base,origin:s.origin,current_vehicle:s.current_vehicle,destination:s.destination,provider_location:s.provider_location,transport_location:s.transport_location,route_context:s.route_context};
}

function json(value:unknown) { return value === undefined ? null : JSON.stringify(value); }
