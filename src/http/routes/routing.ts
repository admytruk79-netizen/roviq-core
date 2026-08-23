import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { routeMaintenanceDemand } from '../../services/routing.js';
import { requireRole } from '../middleware/principal.js';

export async function routingRoutes(app: FastifyInstance) {
  app.post('/api/admin/demands/:id/route', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ createOffer: z.boolean().default(true) }).parse(req.body ?? {});
    try {
      const result = await routeMaintenanceDemand(id);
      let offer = null;
      if (body.createOffer && result.ranked.length) {
        const first = result.ranked[0];
        const r = await pool.query(
          `insert into matches_offers(demand_id,actor_id,score,rank,rule_basis)
           values($1,$2,$3,1,$4) returning *`,
          [id, first.actorId, first.score, 'automated_ranked_filter_v1']
        );
        offer = r.rows[0];
      }
      await audit(req.principal,'route_demand','demand_request',id,'automated_ranked_filter_v1',{
        selectedActorId: result.ranked[0]?.actorId ?? null,
        eligibleCount: result.ranked.length,
        rejectedCount: result.rejected.length
      });
      return { ...result, offer };
    } catch (error) {
      if (error instanceof Error && error.message === 'demand_not_found') return reply.code(404).send({ error:'demand_not_found' });
      throw error;
    }
  });

  app.get('/api/admin/demands/:id/routing-decisions', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string };
    const r = await pool.query('select * from routing_decisions where demand_id=$1 order by evaluated_at desc', [id]);
    return { decisions: r.rows };
  });
}
