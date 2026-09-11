import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { pool } from './db/pool.js';
import { principalMiddleware } from './http/middleware/principal.js';
import { registerApplicationRoutes, registerPublicRoutes } from './http/register-routes.js';
import { assertAdminCaseScope } from './services/admin-case-scope.js';

const deferredBookingConstraintErrors = new Set([
  'deferred_service_case_required_for_booking',
  'deferred_service_appointment_case_mismatch'
]);

const operationalConflictErrors = new Set([
  'appointment_no_show_before_start'
]);

export async function buildApp() {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error:'validation_error', details:err.issues });
    if (err instanceof Error && err.message === 'idempotency_key_reused') return reply.code(409).send({error:err.message});
    if (err instanceof Error && err.message === 'idempotency_key_too_long') return reply.code(400).send({error:err.message});
    if (err instanceof Error && deferredBookingConstraintErrors.has(err.message)) return reply.code(409).send({ error:err.message });
    if (err instanceof Error && operationalConflictErrors.has(err.message)) return reply.code(409).send({ error:err.message });
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
    keyGenerator: (req) => (req.headers.authorization as string | undefined) ?? req.ip
  });

  await registerPublicRoutes(app);
  app.addHook('preHandler', async (req, reply) => {
    const routeConfig = req.routeOptions.config as { public?: boolean } | undefined;
    if (routeConfig?.public || req.url === '/health' || req.url === '/ready') return;
    await principalMiddleware(req, reply);
    if (reply.sent) return;

    const routeUrl=req.routeOptions.url;
    if(req.principal.role==='admin'&&req.principal.actorId&&routeUrl?.startsWith('/api/admin/cases/:id')){
      const caseId=(req.params as {id?:string}|undefined)?.id;
      if(caseId) await assertAdminCaseScope(req.principal,caseId,pool);
    }
  });

  await registerApplicationRoutes(app);
  return app;
}
