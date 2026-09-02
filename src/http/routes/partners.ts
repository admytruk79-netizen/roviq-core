import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { raiseException, transitionCase } from '../../services/orchestration.js';
import { requireRole } from '../middleware/principal.js';

const capacityBody = z.object({
  capacityType: z.string().min(1), quantity: z.number().nonnegative(), startAt: z.string().datetime(), endAt: z.string().datetime(), source: z.string().default('partner_declared')
});

const controlsBody = z.object({
  routingEnabled: z.boolean().default(true),
  acceptsOverflow: z.boolean().default(false),
  releasesOverflow: z.boolean().default(false),
  serviceRadiusMiles: z.number().positive().nullable().optional(),
  operatingHours: z.record(z.unknown()).default({}),
  acceptedJobTypes: z.array(z.string()).default([]),
  excludedJobTypes: z.array(z.string()).default([]),
  oemWarrantyRules: z.record(z.unknown()).default({}),
  maxActiveJobs: z.number().int().nonnegative().nullable().optional(),
  earliestAvailableAt: z.string().datetime().nullable().optional(),
  loanerParticipation: z.boolean().default(false),
  valetParticipation: z.boolean().default(false),
  towParticipation: z.boolean().default(false)
});

export async function partnerRoutes(app: FastifyInstance) {
  app.get('/api/partners/me/capacity', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query('select * from capacity_snapshots where actor_id=$1 order by start_at desc limit 100', [req.principal.actorId]);
    return { capacity: r.rows };
  });

  app.patch('/api/partners/me/capacity', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req, reply) => {
    const b = capacityBody.parse(req.body);
    const r = await pool.query(
      `insert into capacity_snapshots(actor_id, capacity_type, quantity, start_at, end_at, source, confidence)
       values($1,$2,$3,$4,$5,$6,1) returning *`,
      [req.principal.actorId,b.capacityType,b.quantity,b.startAt,b.endAt,b.source]
    );
    await audit(req.principal,'declare_capacity','capacity_snapshot',r.rows[0].id,'actor_owned_capacity');
    return reply.code(201).send({ capacity: r.rows[0] });
  });

  app.get('/api/partners/me/controls', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query('select * from partner_controls where actor_id=$1', [req.principal.actorId]);
    return { controls: r.rows[0] ?? null };
  });

  app.patch('/api/partners/me/controls', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const b = controlsBody.parse(req.body);
    const r = await pool.query(
      `insert into partner_controls(actor_id,routing_enabled,accepts_overflow,releases_overflow,service_radius_miles,
        operating_hours_json,accepted_job_types_json,excluded_job_types_json,oem_warranty_rules_json,max_active_jobs,
        earliest_available_at,loaner_participation,valet_participation,tow_participation,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       on conflict(actor_id) do update set routing_enabled=excluded.routing_enabled, accepts_overflow=excluded.accepts_overflow,
        releases_overflow=excluded.releases_overflow, service_radius_miles=excluded.service_radius_miles,
        operating_hours_json=excluded.operating_hours_json, accepted_job_types_json=excluded.accepted_job_types_json,
        excluded_job_types_json=excluded.excluded_job_types_json, oem_warranty_rules_json=excluded.oem_warranty_rules_json,
        max_active_jobs=excluded.max_active_jobs, earliest_available_at=excluded.earliest_available_at,
        loaner_participation=excluded.loaner_participation, valet_participation=excluded.valet_participation,
        tow_participation=excluded.tow_participation, updated_at=now() returning *`,
      [req.principal.actorId,b.routingEnabled,b.acceptsOverflow,b.releasesOverflow,b.serviceRadiusMiles ?? null,
       JSON.stringify(b.operatingHours),JSON.stringify(b.acceptedJobTypes),JSON.stringify(b.excludedJobTypes),JSON.stringify(b.oemWarrantyRules),
       b.maxActiveJobs ?? null,b.earliestAvailableAt ?? null,b.loanerParticipation,b.valetParticipation,b.towParticipation]
    );
    await audit(req.principal,'update_partner_controls','partner_controls',req.principal.actorId!,'actor_owned_controls');
    return { controls:r.rows[0] };
  });

  app.get('/api/partners/me/offers', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query(
      `select m.*, d.demand_type, d.urgency, d.attributes from matches_offers m
       join demand_requests d on d.id=m.demand_id where m.actor_id=$1 order by m.offered_at desc`,
      [req.principal.actorId]
    );
    return { offers: r.rows };
  });

  app.post('/api/offers/:id/respond', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ outcome: z.enum(['accepted','declined']) }).parse(req.body);
    const r = await pool.query(
      `update matches_offers set outcome=$1, responded_at=now()
       where id=$2 and actor_id=$3 and outcome='offered' returning *`,
      [body.outcome,id,req.principal.actorId]
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'offer_not_found_or_not_owned' });
    const offer = r.rows[0];

    let serviceCase = null;
    if (offer.case_id) {
      const c = await pool.query('select * from service_cases where id=$1',[offer.case_id]);
      serviceCase = c.rows[0] ?? null;
      if (serviceCase && body.outcome === 'accepted') {
        await pool.query('update service_cases set current_owner_role=$1,current_owner_actor_id=$2,updated_at=now() where id=$3',[req.principal.role,req.principal.actorId,offer.case_id]);
        const target = req.principal.role === 'diagnostic' ? 'diagnostic_in_progress' : req.principal.role === 'tow' ? 'tow_in_progress' : req.principal.role === 'parts' ? 'repair_in_progress' : 'repair_in_progress';
        try { serviceCase = await transitionCase(req.principal,offer.case_id,target); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== 'invalid_case_transition' && message !== 'transition_forbidden') {
            console.error('offer_accept_transition_unexpected_error', { caseId: offer.case_id, target, message });
          }
        }
      }
      if (serviceCase && body.outcome === 'declined') {
        if (serviceCase.state === 'provider_pending' && req.principal.role === 'partner') {
          serviceCase = await transitionCase(req.principal,offer.case_id,'provider_selection',{ declinedOfferId:id });
        } else {
          await raiseException(offer.case_id,'OFFER_DECLINED',`${req.principal.role} declined an assigned offer.`,'warning',{ offerId:id,actorId:req.principal.actorId });
        }
      }
    }

    await audit(req.principal,'respond_offer','match_offer',id,'actor_scoped_offer',{ outcome: body.outcome, caseId:offer.case_id ?? null });
    return { offer, case:serviceCase };
  });
}
