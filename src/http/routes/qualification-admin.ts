import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { validIdentityId } from '../../services/audit.js';
import { loadActorQualifications } from '../../services/serviceability-gate.js';
import { requireRole } from '../middleware/principal.js';

const kinds = z.enum(['legal_license','oem_certification','manufacturer_access','training','equipment','facility','parts','capacity','authorization']);
const review = z.object({
  expectedVersion: z.number().int().min(0),
  requirementKey: z.string().trim().min(1).max(150), kind: kinds,
  scope: z.string().trim().min(1).max(200).nullable(),
  status: z.enum(['verified','unverified','expired','revoked']),
  source: z.string().trim().min(3).max(500),
  validUntil: z.string().datetime().nullable(),
  reason: z.string().trim().min(5).max(500)
}).strict().refine(v => v.status !== 'verified' || v.validUntil === null || Date.parse(v.validUntil) > Date.now(),
  'Verified evidence must have a future expiry or explicitly no expiry');

export async function qualificationAdminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole('admin') };
  app.get('/api/admin/qualifications/actors', admin, async (req) => {
    const { search } = z.object({ search: z.string().trim().max(150).default('') }).parse(req.query);
    const actors = await pool.query(`select a.id,a.actor_type,a.status,a.organization_id,o.display_name as business_name,
      a.attributes->>'displayName' as display_name from actors a
      left join organizations o on o.id=a.organization_id
      where a.actor_type <> 'customer' and ($1='' or a.id::text=$1 or o.display_name ilike '%' || $1 || '%'
        or a.attributes->>'displayName' ilike '%' || $1 || '%') order by o.display_name,a.id limit 101`, [search]);
    return { actors: actors.rows.slice(0,100), truncated: actors.rows.length > 100 };
  });

  app.get('/api/admin/qualifications/:actorId', admin, async (req, reply) => {
    const { actorId } = z.object({ actorId: z.string().uuid() }).parse(req.params);
    const actor = await pool.query('select id from actors where id=$1', [actorId]);
    if (!actor.rowCount) return reply.code(404).send({ error: 'actor_not_found' });
    const [evidence, history] = await Promise.all([
      pool.query(`select *,case when evidence_status='verified' and nullif(btrim(verified_source),'') is null then 'unverified'
        when evidence_status='verified' and valid_until<=clock_timestamp() then 'expired'
        else evidence_status end as effective_status from actor_qualification_evidence where actor_id=$1 order by updated_at desc,id`, [actorId]),
      pool.query(`select id,principal_identity_id,occurred_at,metadata from audit_log
        where action='review_actor_qualification' and metadata->>'actorId'=$1 order by occurred_at desc,id desc limit 100`, [actorId])
    ]);
    return { evidence: evidence.rows, history: history.rows };
  });

  // Read-only explanation for requirements already registered on a case. It does not grant work.
  app.get('/api/admin/qualifications/:actorId/cases/:caseId', admin, async (req, reply) => {
    const p = z.object({ actorId: z.string().uuid(), caseId: z.string().uuid() }).parse(req.params);
    const exists = await pool.query(`select 1 from service_cases where id=$1 and exists(select 1 from actors where id=$2)`, [p.caseId,p.actorId]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'case_or_actor_not_found' });
    const at = new Date();
    return { evaluation: await loadActorQualifications(p.caseId,p.actorId,pool,at), evaluatedAt: at.toISOString() };
  });

  // Stable evidence UUID + expectedVersion=0 creates; later reviews must name the current version.
  app.put('/api/admin/qualifications/:actorId/:evidenceId', admin, async (req, reply) => {
    const p = z.object({ actorId: z.string().uuid(), evidenceId: z.string().uuid() }).parse(req.params);
    const identity = validIdentityId(req.principal.identityId);
    if (!identity) return reply.code(403).send({ error: 'identified_admin_required' });
    const input = review.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`qualification:${p.evidenceId}`]);
      // Same actor lock as authoritative provider selection: review and selection serialize.
      const actor = await client.query('select id,actor_type,status from actors where id=$1 for update', [p.actorId]);
      if (!actor.rowCount) { await client.query('rollback'); return reply.code(404).send({ error: 'actor_not_found' }); }
      if (actor.rows[0].actor_type === 'customer' || (input.status === 'verified' && actor.rows[0].status !== 'active')) {
        await client.query('rollback'); return reply.code(409).send({ error: 'actor_not_verifiable' });
      }
      const before = (await client.query('select * from actor_qualification_evidence where id=$1 for update', [p.evidenceId])).rows[0];
      if ((before && before.actor_id !== p.actorId) || (before?.review_version ?? 0) !== input.expectedVersion) {
        await client.query('rollback'); return reply.code(409).send({ error: 'qualification_changed_reload' });
      }
      if (before && (before.requirement_key !== input.requirementKey || before.kind !== input.kind || before.scope !== input.scope)) {
        await client.query('rollback'); return reply.code(409).send({ error: 'qualification_subject_immutable' });
      }
      const result = await client.query(`insert into actor_qualification_evidence
        (id,actor_id,requirement_key,kind,scope,evidence_status,verified_source,verified_by,valid_until,
          review_version,review_reason,reviewed_by_identity_id,reviewed_at)
        values($1,$2,$3,$4,$5,$6,$7,case when $6='verified' then $8 else null end,$9,1,$10,$8,clock_timestamp())
        on conflict(id) do update set evidence_status=excluded.evidence_status,verified_source=excluded.verified_source,
          verified_by=excluded.verified_by,valid_until=excluded.valid_until,review_version=actor_qualification_evidence.review_version+1,
          review_reason=excluded.review_reason,reviewed_by_identity_id=excluded.reviewed_by_identity_id,
          reviewed_at=excluded.reviewed_at,updated_at=clock_timestamp() returning *`,
      [p.evidenceId,p.actorId,input.requirementKey,input.kind,input.scope,input.status,input.source,identity,input.validUntil,input.reason]);
      await client.query(`insert into audit_log(principal_role,principal_identity_id,action,object_type,object_id,metadata)
        values('admin',$1,'review_actor_qualification','actor_qualification_evidence',$2,$3)`,
      [identity,p.evidenceId,JSON.stringify({ actorId:p.actorId,before:before ?? null,after:result.rows[0] })]);
      await client.query('commit');
      return { evidence:result.rows[0] };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  });
}
