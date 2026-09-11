import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { principalMiddleware } from './middleware/principal.js';
import { assertAdminCaseScope } from '../services/admin-case-scope.js';

export function registerAuthorizationHook(app: FastifyInstance) {
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
}
