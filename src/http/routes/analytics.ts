import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/principal.js';
import { getCaseMetrics } from '../../services/analytics.js';

const rangeQuery = z.object({
  from:z.string().datetime().optional(),
  to:z.string().datetime().optional()
});

export async function analyticsRoutes(app:FastifyInstance) {
  app.get('/api/admin/analytics/case-metrics', { preHandler:requireRole('admin') }, async (req) => {
    const query = rangeQuery.parse(req.query ?? {});
    return getCaseMetrics(query);
  });
}
