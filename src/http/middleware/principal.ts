import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import type { Principal, RoviqRole } from '../../types/principal.js';

const roles = new Set<RoviqRole>(['admin','customer','partner','diagnostic','tow','parts','fleet']);

declare module 'fastify' {
  interface FastifyRequest { principal: Principal }
}

export async function principalMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const role = req.headers['x-roviq-role'];
  if (typeof role !== 'string' || !roles.has(role as RoviqRole)) {
    return reply.code(401).send({ error: 'missing_or_invalid_principal' });
  }

  if (role === 'admin') {
    if (req.headers['x-admin-api-key'] !== env.ADMIN_API_KEY) {
      return reply.code(401).send({ error: 'invalid_admin_key' });
    }
    req.principal = { role: 'admin' };
    return;
  }

  const actorId = req.headers['x-roviq-actor-id'];
  if (typeof actorId !== 'string' || !actorId) {
    return reply.code(401).send({ error: 'missing_actor_id' });
  }
  req.principal = { role: role as RoviqRole, actorId };
}

export function requireRole(...allowed: RoviqRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allowed.includes(req.principal.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
