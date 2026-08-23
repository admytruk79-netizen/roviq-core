import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { principalMiddleware } from './http/middleware/principal.js';
import { healthRoutes } from './http/routes/health.js';
import { authRoutes } from './http/routes/auth.js';
import { coreRoutes } from './http/routes/core.js';
import { demandRoutes } from './http/routes/demands.js';
import { partnerRoutes } from './http/routes/partners.js';
import { adminRoutes } from './http/routes/admin.js';
import { routingRoutes } from './http/routes/routing.js';
import { diagnosticRoutes } from './http/routes/diagnostics.js';
import { caseRoutes } from './http/routes/cases.js';

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: false });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  await app.register(healthRoutes);
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health' || req.url === '/ready' || req.url === '/api/auth/login') return;
    await principalMiddleware(req, reply);
  });
  await app.register(authRoutes);
  await app.register(coreRoutes);
  await app.register(demandRoutes);
  await app.register(caseRoutes);
  await app.register(partnerRoutes);
  await app.register(adminRoutes);
  await app.register(routingRoutes);
  await app.register(diagnosticRoutes);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error:'validation_error', details:err.issues });
    app.log.error(err);
    return reply.code(500).send({ error:'internal_error' });
  });
  return app;
}
