import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { loadActorQualifications } from '../../services/serviceability-gate.js';
import { requireRole } from '../middleware/principal.js';

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
}
