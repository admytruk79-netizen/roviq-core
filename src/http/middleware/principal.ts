import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { verifyAccessToken } from '../../services/auth.js';
import type { Principal, RoviqRole } from '../../types/principal.js';

const roles = new Set<RoviqRole>(['admin','customer','partner','diagnostic','tow','parts','fleet']);

declare module 'fastify' {
  interface FastifyRequest { principal: Principal }
}

export async function principalMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    try {
      const verified = await verifyAccessToken(authorization.slice(7));
      if (!roles.has(verified.role)) return reply.code(401).send({ error:'invalid_token_role' });
      req.principal = { role:verified.role, actorId:verified.actorId };
      return;
    } catch {
      return reply.code(401).send({ error:'invalid_or_expired_token' });
    }
  }

  if (!env.ALLOW_DEV_HEADERS) return reply.code(401).send({ error:'bearer_token_required' });

  const role = req.headers['x-roviq-role'];
  if (typeof role !== 'string' || !roles.has(role as RoviqRole)) {
    return reply.code(401).send({ error: 'missing_or_invalid_principal' });
  }
  if (role === 'admin') {
    if (req.headers['x-admin-api-key'] !== env.ADMIN_API_KEY) return reply.code(401).send({ error:'invalid_admin_key' });
    req.principal = { role:'admin' };
    return;
  }
  const actorId = req.headers['x-roviq-actor-id'];
  if (typeof actorId !== 'string' || !actorId) return reply.code(401).send({ error:'missing_actor_id' });
  req.principal = { role:role as RoviqRole, actorId };
}

export function requireRole(...allowed: RoviqRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal) return reply.code(401).send({ error:'bearer_token_required' });
    if (!allowed.includes(req.principal.role)) return reply.code(403).send({ error:'forbidden' });
  };
}

export function requireRoleOrCapability(capabilityCode: string, ...allowed: RoviqRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal) return reply.code(401).send({ error:'bearer_token_required' });
    if (allowed.includes(req.principal.role)) return;
    if (!req.principal.actorId) return reply.code(403).send({ error:'forbidden' });
    const capability = await pool.query(
      `select 1
       from actor_capabilities ac
       join capabilities c on c.id=ac.capability_id
       where ac.actor_id=$1 and ac.active=true and c.capability_code=$2
       limit 1`,
      [req.principal.actorId,capabilityCode]
    );
    if (!capability.rowCount) return reply.code(403).send({ error:'capability_required', capability:capabilityCode });
  };
}
