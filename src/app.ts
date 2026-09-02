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
import { transportRoutes } from './http/routes/transport.js';
import { mobilityRoutes } from './http/routes/mobility.js';
import { partsRoutes } from './http/routes/parts.js';
import { paymentRoutes } from './http/routes/payments.js';
import { notificationRoutes } from './http/routes/notifications.js';
import { triageRoutes } from './http/routes/triage.js';
import { integrationRoutes } from './http/routes/integrations.js';
import { triageEvaluationRoutes } from './http/routes/triage-evaluation.js';
import { servicePlanRoutes } from './http/routes/service-plans.js';
import { coherenceRoutes } from './http/routes/coherence.js';
import { fieldServiceRoutes } from './http/routes/field-service.js';

export async function buildApp() {
  // Pino/Fastify logging currently triggers a Worker startup incompatibility.
  // Keep logging disabled at the Fastify layer; Cloudflare observability remains enabled.
  const app = Fastify({ logger: false, disableRequestLogging: true });

  // Registered before any route plugins: Fastify's encapsulation model only lets child
  // contexts (every app.register(xRoutes) below) inherit a parent error handler that was
  // set before they were registered, not one set afterward.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error:'validation_error', details:err.issues });
    if (err instanceof Error && err.message === 'idempotency_key_reused') return reply.code(409).send({error:err.message});
    if (err instanceof Error && err.message === 'idempotency_key_too_long') return reply.code(400).send({error:err.message});
    console.error('roviq_core_error', err);
    return reply.code(500).send({ error:'internal_error' });
  });

  await app.register(cors, { origin: false });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  await app.register(healthRoutes);
  app.addHook('preHandler', async (req, reply) => {
    const routeConfig = req.routeOptions.config as { public?: boolean } | undefined;
    if (routeConfig?.public || req.url === '/health' || req.url === '/ready') return;
    await principalMiddleware(req, reply);
  });
  await app.register(authRoutes);
  await app.register(coreRoutes);
  await app.register(demandRoutes);
  await app.register(caseRoutes);
  await app.register(coherenceRoutes);
  await app.register(fieldServiceRoutes);
  await app.register(servicePlanRoutes);
  await app.register(partnerRoutes);
  await app.register(adminRoutes);
  await app.register(routingRoutes);
  await app.register(diagnosticRoutes);
  await app.register(transportRoutes);
  await app.register(mobilityRoutes);
  await app.register(partsRoutes);
  await app.register(paymentRoutes);
  await app.register(notificationRoutes);
  await app.register(triageRoutes);
  await app.register(integrationRoutes);
  await app.register(triageEvaluationRoutes);

  return app;
}
