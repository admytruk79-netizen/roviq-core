import type { FastifyInstance } from 'fastify';
import { requireRole } from '../middleware/principal.js';
import { businessOnboardingSchema, BusinessOnboardingError, onboardBusiness, listOnboardedBusinesses } from '../../services/business-onboarding.js';

export async function businessOnboardingRoutes(app: FastifyInstance) {
  app.get('/api/admin/business-onboarding', { preHandler: requireRole('admin') }, async () => ({ businesses: await listOnboardedBusinesses() }));
  app.post('/api/admin/business-onboarding', {
    preHandler: requireRole('admin'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const input = businessOnboardingSchema.parse(req.body);
    try {
      const business = await onboardBusiness(req.principal, input);
      return reply.code(business.replayed ? 200 : 201).send({ business });
    } catch (error) {
      if (error instanceof BusinessOnboardingError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
}
