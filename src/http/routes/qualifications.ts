import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { loadActorQualifications } from '../../services/serviceability-gate.js';
import { requireRole } from '../middleware/principal.js';

// Ops management for case qualification requirements and actors' verified credentials (MACRE).
// Requirements say what a case needs ("EV high-voltage training"); evidence says what a
// technician or shop holds and who verified it. Evidence is never deleted: it is revoked or
// expired, so every past assignment decision stays explainable. Admin only; evidence is never
// exposed through actor-facing APIs.

const KINDS = ['legal_license', 'oem_certification', 'manufacturer_access', 'training', 'equipment', 'facility', 'parts', 'capacity', 'authorization'] as const;
const key = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.:-]{1,79}$/, 'Use lowercase letters, digits and _ . : -');
const scope = z.string().trim().min(1).max(120).optional();
const uuid = z.string().uuid();

const requirementBody = z.object({ requirementKey: key, kind: z.enum(KINDS), scope, mandatory: z.boolean().default(true) });
const evidenceBody = z.object({
  requirementKey: key,
  kind: z.enum(KINDS),
  scope,
  status: z.enum(['verified', 'unverified']).default('verified'),
  verifiedSource: z.string().trim().min(3).max(300).optional(),
  validUntil: z.string().datetime().optional()
}).refine((b) => b.status !== 'verified' || Boolean(b.verifiedSource), { message: 'Verified evidence needs a source reference', path: ['verifiedSource'] });
const evidenceUpdate = z.object({ status: z.enum(['verified', 'expired', 'revoked']), verifiedSource: z.string().trim().min(3).max(300).optional(), validUntil: z.string().datetime().nullable().optional() });

export async function qualificationRoutes(app: FastifyInstance) {
  app.get('/api/admin/cases/:id/qualifications', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const exists = await pool.query('select 1 from service_cases where id=$1', [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'case_not_found' });
    const r = await pool.query(
      'select requirement_key, kind, scope, mandatory, created_at from case_qualification_requirements where service_case_id=$1 order by requirement_key',
      [id]
    );
    return { requirements: r.rows };
  });

  app.put('/api/admin/cases/:id/qualifications', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = requirementBody.parse(req.body);
    const exists = await pool.query('select 1 from service_cases where id=$1', [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'case_not_found' });
    const r = await pool.query(
      `insert into case_qualification_requirements(service_case_id, requirement_key, kind, scope, mandatory)
       values($1,$2,$3,$4,$5)
       on conflict (service_case_id, requirement_key) do update set kind=excluded.kind, scope=excluded.scope, mandatory=excluded.mandatory
       returning requirement_key, kind, scope, mandatory, created_at`,
      [id, body.requirementKey, body.kind, body.scope ?? null, body.mandatory]
    );
    await audit(req.principal, 'set_case_qualification', 'service_case', id, 'macre_requirement', body);
    return reply.code(201).send({ requirement: r.rows[0] });
  });

  app.delete('/api/admin/cases/:id/qualifications/:key', { preHandler: requireRole('admin') }, async (req, reply) => {
    const params = req.params as { id: string; key: string };
    const id = uuid.parse(params.id);
    const requirementKey = key.parse(params.key);
    const r = await pool.query('delete from case_qualification_requirements where service_case_id=$1 and requirement_key=$2 returning requirement_key', [id, requirementKey]);
    if (!r.rowCount) return reply.code(404).send({ error: 'requirement_not_found' });
    await audit(req.principal, 'remove_case_qualification', 'service_case', id, 'macre_requirement', { requirementKey });
    return { removed: requirementKey };
  });

  // Who could take this case: each active actor of a type, with the requirements they miss.
  app.get('/api/admin/cases/:id/qualifications/candidates', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const { actorType } = z.object({ actorType: z.enum(['diagnostic', 'shop', 'tow', 'partner', 'parts', 'fleet']).default('diagnostic') }).parse(req.query);
    const exists = await pool.query('select 1 from service_cases where id=$1', [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'case_not_found' });
    const actors = await pool.query(
      `select id, coalesce(attributes->>'displayName', attributes->>'name', attributes->>'businessName') as name
         from actors where actor_type=$1 and status='active' order by created_at asc limit 100`,
      [actorType]
    );
    const now = new Date();
    const candidates = [];
    for (const a of actors.rows) {
      const q = await loadActorQualifications(id, a.id, pool, now);
      candidates.push({ actorId: a.id, name: a.name, decision: q.decision, blockingReasons: q.blockingReasons, reviewReasons: q.reviewReasons });
    }
    return { candidates };
  });

  app.get('/api/admin/actors/:id/qualification-evidence', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const exists = await pool.query('select 1 from actors where id=$1', [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'actor_not_found' });
    const r = await pool.query(
      `select id, requirement_key, kind, scope, evidence_status, verified_source, verified_by, valid_until, created_at, updated_at
         from actor_qualification_evidence where actor_id=$1 order by requirement_key, created_at desc`,
      [id]
    );
    return { evidence: r.rows };
  });

  app.post('/api/admin/actors/:id/qualification-evidence', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = evidenceBody.parse(req.body);
    if (body.validUntil && Date.parse(body.validUntil) <= Date.now()) return reply.code(400).send({ error: 'evidence_already_expired' });
    const exists = await pool.query('select 1 from actors where id=$1', [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'actor_not_found' });
    const verifiedBy = body.status === 'verified' ? (req.principal.identityId ?? req.principal.actorId ?? req.principal.role) : null;
    const r = await pool.query(
      `insert into actor_qualification_evidence(actor_id, requirement_key, kind, scope, evidence_status, verified_source, verified_by, valid_until)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [id, body.requirementKey, body.kind, body.scope ?? null, body.status, body.verifiedSource ?? null, verifiedBy, body.validUntil ?? null]
    );
    await audit(req.principal, 'record_qualification_evidence', 'actor', id, 'macre_evidence', { evidenceId: r.rows[0].id, ...body });
    return reply.code(201).send({ evidence: r.rows[0] });
  });

  app.patch('/api/admin/actors/:id/qualification-evidence/:evidenceId', { preHandler: requireRole('admin') }, async (req, reply) => {
    const params = req.params as { id: string; evidenceId: string };
    const id = uuid.parse(params.id);
    const evidenceId = uuid.parse(params.evidenceId);
    const body = evidenceUpdate.parse(req.body);
    const current = await pool.query('select verified_source from actor_qualification_evidence where id=$1 and actor_id=$2', [evidenceId, id]);
    if (!current.rowCount) return reply.code(404).send({ error: 'evidence_not_found' });
    if (body.status === 'verified' && !(body.verifiedSource ?? current.rows[0].verified_source)) return reply.code(400).send({ error: 'verified_source_required' });
    const verifiedBy = body.status === 'verified' ? (req.principal.identityId ?? req.principal.actorId ?? req.principal.role) : null;
    const r = await pool.query(
      `update actor_qualification_evidence
          set evidence_status=$3,
              verified_source=coalesce($4, verified_source),
              verified_by=coalesce($5, verified_by),
              valid_until=case when $6::boolean then $7::timestamptz else valid_until end,
              updated_at=now()
        where id=$1 and actor_id=$2 returning *`,
      [evidenceId, id, body.status, body.verifiedSource ?? null, verifiedBy, body.validUntil !== undefined, body.validUntil ?? null]
    );
    await audit(req.principal, 'update_qualification_evidence', 'actor', id, 'macre_evidence', { evidenceId, ...body });
    return { evidence: r.rows[0] };
  });
}
