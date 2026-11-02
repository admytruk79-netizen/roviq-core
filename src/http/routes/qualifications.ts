import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { loadActorQualifications } from '../../services/serviceability-gate.js';
import { requireRole } from '../middleware/principal.js';
import { suggestQualificationRequirements } from '../../domain/dtc-knowledge.js';

// "Who qualifies for this case": every active actor of a type, evaluated against the case's
// registered requirements with the same loader the assignment gates use. Read-only; it grants
// nothing. Requirements and evidence are written through qualification-admin.ts.

export async function qualificationRoutes(app: FastifyInstance) {
  app.get('/api/admin/qualifications/cases/:caseId/candidates', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { caseId } = z.object({ caseId: z.string().uuid() }).parse(req.params);
    const { actorType } = z.object({ actorType: z.enum(['diagnostic', 'shop', 'tow', 'partner', 'parts', 'fleet']).default('diagnostic') }).parse(req.query);
    const exists = await pool.query('select 1 from service_cases where id=$1', [caseId]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'case_not_found' });
    const actors = await pool.query(
      `select a.id, coalesce(a.attributes->>'displayName', a.attributes->>'name', o.display_name) as name
         from actors a left join organizations o on o.id = a.organization_id
        where a.actor_type=$1 and a.status='active' order by a.created_at asc limit 100`,
      [actorType]
    );
    const at = new Date();
    const candidates = [];
    for (const a of actors.rows) {
      const q = await loadActorQualifications(caseId, a.id, pool, at);
      candidates.push({ actorId: a.id, name: a.name, decision: q.decision, blockingReasons: q.blockingReasons, reviewReasons: q.reviewReasons });
    }
    return { candidates, evaluatedAt: at.toISOString() };
  });

  // What this job is likely to need, read from the vehicle, the customer's description, triage
  // and any recorded scanner codes. Suggestions only: Ops adds them through the audited
  // requirement endpoint, with its own name and reason, or ignores them.
  app.get('/api/admin/qualifications/cases/:caseId/suggested-requirements', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { caseId } = z.object({ caseId: z.string().uuid() }).parse(req.params);
    const found = await pool.query(
      `select sc.attributes as case_attributes, dr.attributes as demand_attributes, v.fuel_type, v.make, v.model, v.year
         from service_cases sc
         left join demand_requests dr on dr.id = sc.demand_id
         left join customer_vehicles v on v.id = sc.vehicle_id
        where sc.id=$1`,
      [caseId]
    );
    if (!found.rowCount) return reply.code(404).send({ error: 'case_not_found' });
    const c = found.rows[0];
    const [triage, scans, registered] = await Promise.all([
      pool.query(`select symptom_summary, input_snapshot->>'symptoms' as symptoms from ai_triage_assessments where case_id=$1 order by created_at desc limit 3`, [caseId]),
      pool.query(`select dtc_codes from vehicle_health_events where service_case_id=$1 and event_type='obd_scan' order by occurred_at desc limit 5`, [caseId]),
      pool.query('select requirement_key from case_qualification_requirements where service_case_id=$1', [caseId])
    ]);
    const describe = (a: Record<string, unknown> | null) => [a?.description, a?.demandType].filter((x) => typeof x === 'string');
    const symptoms = [...describe(c.case_attributes), ...describe(c.demand_attributes), ...triage.rows.flatMap((t) => [t.symptoms, t.symptom_summary])]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    const dtcCodes = [...new Set(scans.rows.flatMap((r) => (Array.isArray(r.dtc_codes) ? r.dtc_codes : [])))];
    const have = new Set(registered.rows.map((r) => r.requirement_key));
    const suggestions = suggestQualificationRequirements({ powertrain: c.fuel_type, symptoms: [...new Set(symptoms)].join('\n'), dtcCodes })
      .map((s) => ({ ...s, registered: have.has(s.requirementKey) }));
    return {
      suggestions,
      basedOn: {
        vehicle: [c.year, c.make, c.model].filter(Boolean).join(' ') || null,
        powertrain: c.fuel_type ?? null,
        descriptions: symptoms.length,
        dtcCodes
      }
    };
  });
}
