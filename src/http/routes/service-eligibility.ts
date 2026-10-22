import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { validIdentityId } from '../../services/audit.js';
import { requireRole } from '../middleware/principal.js';

const service = z.enum(['repair','diagnostic','tow','valet','parts','mobility']);
const reviewSchema = z.object({
  state: z.enum(['pending','verified','suspended','revoked']),
  validFrom: z.string().datetime(), expiresAt: z.string().datetime().optional(),
  evidenceReference: z.string().trim().min(3).max(300), reason: z.string().trim().min(5).max(500)
}).refine(v => !v.expiresAt || Date.parse(v.expiresAt) > Date.parse(v.validFrom), 'Expiry must be after valid-from')
  .refine(v => v.state !== 'verified' || Boolean(v.expiresAt), 'Verified services require an expiry');

export async function serviceEligibilityRoutes(app: FastifyInstance) {
  app.get('/api/admin/service-eligibility', { preHandler: requireRole('admin') }, async () => {
    const [organizations, authorizations, review] = await Promise.all([
      pool.query(`select o.id,o.display_name as name,(p.organization_id is not null) as managed
        from organizations o left join business_service_policies p on p.organization_id=o.id
        order by o.display_name,o.id limit 500`),
      pool.query(`select c.*,c.state='verified' and c.valid_from<=clock_timestamp() and c.expires_at>clock_timestamp() as eligible,
        case when c.state='verified' and c.expires_at<=clock_timestamp() then 'expired'
          when c.state='verified' and c.valid_from>clock_timestamp() then 'not_yet_valid' else c.state end as effective_state
        from business_service_authorizations c order by c.updated_at desc limit 1000`),
      pool.query(`select w.*,a.organization_id,o.display_name as business_name from business_service_work w
        join actors a on a.id=w.actor_id join organizations o on o.id=a.organization_id
        join business_service_policies p on p.organization_id=a.organization_id
        join service_cases sc on sc.id=w.case_id
        where sc.state not in ('completed','cancelled','payment_pending') and not actor_service_eligible(w.actor_id,w.service)
        order by w.case_id,w.reference_type,w.reference_id limit 500`)
    ]);
    return { organizations: organizations.rows, authorizations: authorizations.rows, review: review.rows };
  });

  app.get('/api/me/service-eligibility', async (req, reply) => {
    if (!req.principal.actorId) return reply.code(403).send({ error: 'actor_required' });
    const result = await pool.query(`select a.organization_id,(p.organization_id is not null) as managed,
      coalesce((select jsonb_agg(jsonb_build_object('service',c.service,'state',c.state,'expiresAt',c.expires_at,
        'eligible',actor_service_eligible(a.id,c.service))) from business_service_authorizations c
        where c.organization_id=a.organization_id),'[]'::jsonb) as services
      from actors a left join business_service_policies p on p.organization_id=a.organization_id where a.id=$1`, [req.principal.actorId]);
    return { eligibility: result.rows[0] ?? null };
  });

  app.post('/api/admin/service-eligibility/:organizationId/enroll', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(req.params);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const org = await client.query('select id from organizations where id=$1 for update', [organizationId]);
      if (!org.rowCount) { await client.query('rollback'); return reply.code(404).send({ error: 'organization_not_found' }); }
      const inserted = await client.query(`insert into business_service_policies(organization_id) values($1) on conflict do nothing returning organization_id`, [organizationId]);
      if (inserted.rowCount) await client.query(`insert into audit_log(principal_role,principal_identity_id,action,object_type,object_id,metadata)
        values('admin',$1,'enroll_service_eligibility','organization',$2,'{}')`, [validIdentityId(req.principal.identityId), organizationId]);
      await client.query('commit');
      return { managed: true };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  });

  app.put('/api/admin/service-eligibility/:organizationId/:service', { preHandler: requireRole('admin') }, async (req, reply) => {
    const params = z.object({ organizationId: z.string().uuid(), service }).parse(req.params);
    const input = reviewSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from organizations where id=$1 for update', [params.organizationId]);
      const policy = await client.query('select 1 from business_service_policies where organization_id=$1', [params.organizationId]);
      if (!policy.rowCount) { await client.query('rollback'); return reply.code(409).send({ error: 'business_not_enrolled' }); }
      const previous = await client.query(`select * from business_service_authorizations where organization_id=$1 and service=$2`, [params.organizationId, params.service]);
      const result = await client.query(`insert into business_service_authorizations
        (organization_id,service,state,valid_from,expires_at,evidence_reference,verified_by_identity_id,verified_at,review_reason)
        values($1,$2,$3,$4,$5,$6,$7,case when $3='verified' then clock_timestamp() else null end,$8)
        on conflict(organization_id,service) do update set state=excluded.state,valid_from=excluded.valid_from,
        expires_at=excluded.expires_at,evidence_reference=excluded.evidence_reference,verified_by_identity_id=excluded.verified_by_identity_id,
        verified_at=excluded.verified_at,review_reason=excluded.review_reason,updated_at=now() returning *`,
      [params.organizationId, params.service, input.state, input.validFrom, input.expiresAt ?? null, input.evidenceReference,
        validIdentityId(req.principal.identityId), input.reason]);
      await client.query(`insert into audit_log(principal_role,principal_identity_id,action,object_type,object_id,metadata)
        values('admin',$1,'review_service_credential','organization',$2,$3)`, [validIdentityId(req.principal.identityId), params.organizationId,
        JSON.stringify({ service: params.service, before: previous.rows[0] ?? null, after: result.rows[0] })]);
      await client.query('commit');
      return { authorization: result.rows[0] };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  });
}
