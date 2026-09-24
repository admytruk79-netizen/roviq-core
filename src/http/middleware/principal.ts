import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { verifyAccessToken } from '../../services/auth.js';
import type { Principal, RoviqRole } from '../../types/principal.js';

function adminKeyMatches(supplied: unknown, expected: string) {
  if (typeof supplied !== 'string') return false;
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  return suppliedBuf.length === expectedBuf.length && timingSafeEqual(suppliedBuf, expectedBuf);
}

const roles = new Set<RoviqRole>(['admin','customer','partner','diagnostic','tow','parts','fleet']);
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


async function validateBearerPrincipal(input:{identityId:string;role:RoviqRole;actorId?:string}){
  if(!UUID_RE.test(input.identityId)){
    if(env.ALLOW_DEV_HEADERS) return true;
    return false;
  }
  const result=await pool.query(
    `select pi.role,pi.actor_id,pi.active,a.status as actor_status
       from principal_identities pi
       left join actors a on a.id=pi.actor_id
      where pi.id=$1
      limit 1`,
    [input.identityId]
  );
  if(!result.rowCount) return false;
  const row=result.rows[0];
  if(row.active!==true) return false;
  if(row.role!==input.role) return false;
  if((row.actor_id??undefined)!==(input.actorId??undefined)) return false;
  if(input.role!=='admin'&&row.actor_status!=='active') return false;
  return true;
}

declare module 'fastify' {
  interface FastifyRequest { principal: Principal }
}

export async function principalMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    try {
      const verified = await verifyAccessToken(authorization.slice(7));
      if (!roles.has(verified.role)) return reply.code(401).send({ error:'invalid_token_role' });
      if(!await validateBearerPrincipal({identityId:verified.identityId,role:verified.role,actorId:verified.actorId})) return reply.code(401).send({error:'inactive_or_revoked_identity'});
      req.principal = { role:verified.role, actorId:verified.actorId, identityId:verified.identityId };
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
    if (!adminKeyMatches(req.headers['x-admin-api-key'], env.ADMIN_API_KEY)) return reply.code(401).send({ error:'invalid_admin_key' });
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
