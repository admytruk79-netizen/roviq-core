import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { pool } from './db/pool.js';
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
import { quoteRoutes } from './http/routes/quotes.js';
import { analyticsRoutes } from './http/routes/analytics.js';
import { coherenceRoutes } from './http/routes/coherence.js';
import { fieldServiceRoutes } from './http/routes/field-service.js';
import { exceptionRoutes } from './http/routes/exceptions.js';
import { shopOsRoutes } from './http/routes/shop-os.js';
import { shopOsFloorRoutes } from './http/routes/shop-os-floor.js';
import { localRoutes } from './http/routes/local.js';
import { assertAdminCaseScope } from './services/admin-case-scope.js';

const deferredBookingConstraintErrors = new Set([
  'deferred_service_case_required_for_booking',
  'deferred_service_appointment_case_mismatch'
]);

export async function buildApp() {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error:'validation_error', details:err.issues });
    if (err instanceof Error && err.message === 'idempotency_key_reused') return reply.code(409).send({error:err.message});
    if (err instanceof Error && err.message === 'idempotency_key_too_long') return reply.code(400).send({error:err.message});
    if (err instanceof Error && deferredBookingConstraintErrors.has(err.message)) {
      return reply.code(409).send({ error:err.message });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: err instanceof Error ? err.message : 'request_error' });
    }
    console.error('roviq_core_error', err);
    return reply.code(500).send({ error:'internal_error' });
  });

  await app.register(cors, { origin: false });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip
  });

  await app.register(healthRoutes);
  app.addHook('preHandler', async (req, reply) => {
    const routeConfig = req.routeOptions.config as { public?: boolean } | undefined;
    if (routeConfig?.public || req.url === '/health' || req.url === '/ready') return;
    await principalMiddleware(req, reply);
    if(reply.sent)return;

    const routeUrl=req.routeOptions.url;
    if(req.principal.role==='admin'&&req.principal.actorId){
      if(routeUrl?.startsWith('/api/admin/cases/:id')){
        const caseId=(req.params as {id?:string}|undefined)?.id;
        if(caseId) await assertAdminCaseScope(req.principal,caseId,pool);
      }
    }
  });
  await app.register(authRoutes);
  await app.register(coreRoutes);
  await app.register(demandRoutes);
  await app.register(caseRoutes);
  await app.register(exceptionRoutes);
  await app.register(coherenceRoutes);
  await app.register(fieldServiceRoutes);
  await app.register(servicePlanRoutes);
  await app.register(quoteRoutes);
  await app.register(analyticsRoutes);
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
  await app.register(shopOsRoutes);
  await app.register(shopOsFloorRoutes);
  await app.register(localRoutes);
  await app.register(triageEvaluationRoutes);

  return app;
}
