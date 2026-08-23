import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { raiseException, transitionCase } from '../../services/orchestration.js';
import { routeMaintenanceDemand } from '../../services/routing.js';
import { requireRole } from '../middleware/principal.js';

export async function routingRoutes(app: FastifyInstance) {
  app.post('/api/admin/demands/:id/route', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ createOffer: z.boolean().default(true) }).parse(req.body ?? {});
    try {
      const result = await routeMaintenanceDemand(id);
      const caseResult = await pool.query('select * from service_cases where demand_id=$1 order by created_at desc limit 1',[id]);
      let serviceCase = caseResult.rows[0] ?? null;

      if (serviceCase && ['triage','diagnostic_in_progress'].includes(serviceCase.state)) {
        serviceCase = await transitionCase(req.principal,serviceCase.id,'provider_selection',{ source:'routing_engine' });
      }

      let offer = null;
      if (body.createOffer && result.ranked.length) {
        const first = result.ranked[0];
        const r = await pool.query(
          `insert into matches_offers(demand_id,case_id,actor_id,score,rank,rule_basis)
           values($1,$2,$3,$4,1,$5) returning *`,
          [id, serviceCase?.id ?? null, first.actorId, first.score, 'automated_ranked_filter_v1']
        );
        offer = r.rows[0];
        if (serviceCase?.state === 'provider_selection') {
          serviceCase = await transitionCase(req.principal,serviceCase.id,'provider_pending',{ offerId:offer.id, providerActorId:first.actorId });
        }
      } else if (serviceCase && !result.ranked.length) {
        await raiseException(serviceCase.id,'NO_ELIGIBLE_PROVIDER','No eligible provider found for the current service requirements.','warning',{ demandId:id });
      }

      await audit(req.principal,'route_demand','demand_request',id,'automated_ranked_filter_v1',{
        caseId:serviceCase?.id ?? null,
        selectedActorId: result.ranked[0]?.actorId ?? null,
        eligibleCount: result.ranked.length,
        rejectedCount: result.rejected.length
      });
      return { ...result, case:serviceCase, offer };
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
