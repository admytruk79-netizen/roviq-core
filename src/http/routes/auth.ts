import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { hashPassword, issueAccessToken, verifyPassword } from '../../services/auth.js';
import { requireRole } from '../middleware/principal.js';

const loginBody = z.object({ email: z.string().email(), password: z.string().min(8) });
const createIdentityBody = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  role: z.enum(['admin','customer','partner','diagnostic','tow','parts','fleet']),
  actorId: z.string().uuid().nullable().optional()
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const b = loginBody.parse(req.body);
    const r = await pool.query(
      'select id,actor_id,email,role,password_salt,password_hash,active from principal_identities where lower(email)=lower($1) limit 1',
      [b.email]
    );
    const identity = r.rows[0];
    if (!identity || !identity.active || !verifyPassword(b.password, identity.password_salt, identity.password_hash)) {
      return reply.code(401).send({ error:'invalid_credentials' });
    }
    const principal = { role: identity.role, actorId: identity.actor_id ?? undefined };
    const accessToken = await issueAccessToken(identity.id, principal);
    return { accessToken, tokenType:'Bearer', expiresIn:28800, principal:{ role:identity.role, actorId:identity.actor_id } };
  });

  app.post('/api/admin/identities', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = createIdentityBody.parse(req.body);
    if (b.role === 'admin' && b.actorId) return reply.code(400).send({ error:'admin_identity_must_not_have_actor' });
    if (b.role !== 'admin' && !b.actorId) return reply.code(400).send({ error:'actor_required_for_non_admin' });
    const { salt, hash } = hashPassword(b.password);
    try {
      const r = await pool.query(
        `insert into principal_identities(actor_id,email,role,password_salt,password_hash)
         values($1,lower($2),$3,$4,$5) returning id,actor_id,email,role,active,created_at`,
        [b.actorId ?? null,b.email,b.role,salt,hash]
      );
      return reply.code(201).send({ identity:r.rows[0] });
    } catch (error: any) {
      if (error?.code === '23505') return reply.code(409).send({ error:'identity_email_exists' });
      throw error;
    }
  });
}
