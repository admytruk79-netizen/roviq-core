import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { registerAuthorizationHook } from './http/auth-hook.js';
import { registerErrorHandler } from './http/error-handler.js';
import { registerApplicationRoutes, registerPublicRoutes } from './http/register-routes.js';

export async function buildApp() {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  registerErrorHandler(app);
  await app.register(cors, { origin: false });
  await app.register(helmet);

  // Authenticate before the limiter runs so traffic forwarded through the same
  // trusted edge/proxy address is not collapsed into one global IP bucket.
  // Public routes (including login) are still limited by source IP because the
  // authorization hook deliberately leaves them without a principal.
  registerAuthorizationHook(app);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req) => {
      const principal = req.principal;
      if (principal?.identityId || principal?.actorId) {
        return [
          'principal',
          principal.role,
          principal.identityId ?? 'no-identity',
          principal.actorId ?? 'no-actor'
        ].join(':');
      }
      return `ip:${req.ip}`;
    }
  });

  await registerPublicRoutes(app);
  await registerApplicationRoutes(app);

  return app;
}
