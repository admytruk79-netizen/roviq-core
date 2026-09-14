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
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.headers.authorization as string | undefined) ?? req.ip
  });

  await registerPublicRoutes(app);
  registerAuthorizationHook(app);
  await registerApplicationRoutes(app);

  return app;
}
