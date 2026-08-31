import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { transitionCase } from '../../services/orchestration.js';
import { requireRole } from '../middleware/principal.js';

const findingBody = z.object({
  findingCode: z.string().optional(),
  summary: z.string().min(3),
  drivability: z.enum(['drivable','limited','non_drivable','unknown']),
  disposition: z.enum(['diagnose_only','diagnose_and_fix','route_to_shop','route_to_tow']),
  confidence: z.number().min(0).max(1).optional(),
  details: z.record(z.unknown()).default({})
});

export async function diagnosticRoutes(app: FastifyInstance) {
  app.get('/api/diagnostics/me/queue', { preHandler: requireRole('diagnostic') }, async (req) => {
    const r = await pool.query(
      `select m.id as offer_id, m.case_id, m.demand_id, m.offered_at, d.demand_type, d.urgency, d.location, d.attributes
       from matches_offers m join demand_requests d on d.id=m.demand_id
       where m.actor_id=$1 and m.outcome in ('offered','accepted')
       order by d.urgency desc, m.offered_at asc`, [req.principal.actorId]
    );
    return { queue: r.rows };
  });

  app.post('/api/diagnostics/demands/:id/findings', { preHandler: requireRole('diagnostic') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = findingBody.parse(req.body);
    const owned = await pool.query(
      `select case_id from matches_offers where demand_id=$1 and actor_id=$2 and outcome='accepted' order by responded_at desc limit 1`,
      [id, req.principal.actorId]
    );
    if (!owned.rowCount) return reply.code(403).send({ error:'diagnostic_demand_not_assigned' });
    const caseId = owned.rows[0].case_id ?? (await pool.query('select id from service_cases where demand_id=$1 order by created_at desc limit 1',[id])).rows[0]?.id ?? null;

    // Recording a real finding means diagnostic work has started. Accept a finding while the
    // assigned case is still pending by advancing it through the explicit in-progress state
    // before applying the finding's disposition. This preserves the state machine instead of
    // attempting an invalid diagnostic_pending -> provider/tow/repair jump.
    if (caseId) {
      const current = await pool.query('select state from service_cases where id=$1',[caseId]);
      if (current.rows[0]?.state === 'diagnostic_pending') {
        await transitionCase(req.principal,caseId,'diagnostic_in_progress',{ source:'diagnostic_finding_started' });
      }
    }

    const r = await pool.query(
      `insert into diagnostic_findings(demand_id,case_id,diagnostic_actor_id,finding_code,summary,drivability,disposition,confidence,details)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [id,caseId,req.principal.actorId,b.findingCode ?? null,b.summary,b.drivability,b.disposition,b.confidence ?? null,JSON.stringify(b.details)]
    );

    const nextDemandState = b.disposition === 'diagnose_and_fix' ? 'in_progress' : b.disposition === 'diagnose_only' ? 'diagnosed' : 'routing_required';
    await pool.query('update demand_requests set state=$1, updated_at=now() where id=$2', [nextDemandState,id]);

    let serviceCase = null;
    if (caseId) {
      await pool.query('update service_cases set drivability=$1,updated_at=now() where id=$2',[b.drivability,caseId]);
      const target = b.disposition === 'diagnose_and_fix' ? 'repair_in_progress' : b.disposition === 'route_to_tow' || b.drivability === 'non_drivable' ? 'tow_pending' : 'provider_selection';
      serviceCase = await transitionCase(req.principal,caseId,target,{ findingId:r.rows[0].id, disposition:b.disposition, drivability:b.drivability });
    }

    await pool.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('demand_request',$1,'diagnostic_finding_recorded',$2,$3)`,
      [id,req.principal.actorId,JSON.stringify({ findingId:r.rows[0].id, caseId, drivability:b.drivability, disposition:b.disposition })]
    );
    await audit(req.principal,'record_diagnostic_finding','demand_request',id,'assigned_diagnostic_only',{ caseId, disposition:b.disposition });
    return reply.code(201).send({ finding:r.rows[0], demandState:nextDemandState, case:serviceCase });
  });

  app.get('/api/demands/:id/diagnostic-findings', { preHandler: requireRole('admin','customer','diagnostic','partner','tow') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.principal.role !== 'admin' && req.principal.role !== 'customer') {
      const scoped = await pool.query('select 1 from matches_offers where demand_id=$1 and actor_id=$2 limit 1',[id,req.principal.actorId]);
      if (!scoped.rowCount) return reply.code(403).send({ error:'forbidden' });
    }
    if (req.principal.role === 'customer') {
      const owned = await pool.query('select 1 from demand_requests where id=$1 and requester_actor_id=$2',[id,req.principal.actorId]);
      if (!owned.rowCount) return reply.code(403).send({ error:'forbidden' });
    }
    const r = await pool.query(
      `select id,demand_id,case_id,finding_code,summary,drivability,disposition,confidence,created_at
       from diagnostic_findings where demand_id=$1 order by created_at desc`, [id]
    );
    return { findings:r.rows };
  });
}
