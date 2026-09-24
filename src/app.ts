import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { registerAuthorizationHook } from './http/auth-hook.js';
import { registerErrorHandler } from './http/error-handler.js';
import { registerApplicationRoutes, registerPublicRoutes } from './http/register-routes.js';
import { registerRequestContext } from './http/request-context.js';

export async function buildApp() {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  registerRequestContext(app);
  registerErrorHandler(app);
  await app.register(cors, { origin: false });
  await app.register(helmet);

  // Authenticate before the limiter runs so traffic forwarded through the same
  // trusted edge/proxy address is not collapsed into one global IP bucket.
  // Authenticated workflow traffic legitimately combines portal refreshes with
  // state polling, so it gets a higher per-principal ceiling. Public/auth-entry
  // routes remain IP-keyed and sensitive routes can override this globally
  // configured ceiling with a stricter route-level policy.
  registerAuthorizationHook(app);
  await app.register(rateLimit, {
    max: 600,
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
