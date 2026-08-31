import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { hashPassword, issueAccessToken, verifyPassword } from '../../services/auth.js';
import { audit } from '../../services/audit.js';
import { requireRole } from '../middleware/principal.js';

const loginBody = z.object({ email: z.string().email(), password: z.string().min(8) });
const createIdentityBody = z.object({
  email: z.string().email(), password: z.string().min(12),
  role: z.enum(['admin','customer','partner','diagnostic','tow','parts','fleet']),
  actorId: z.string().uuid().nullable().optional()
});

type TestRole='customer'|'partner'|'tow'|'diagnostic'|'parts';

async function adminTestSession(req:any, reply:any, role:TestRole) {
  const domain = await pool.query("select id from domains where code='maintenance' limit 1");
  if (!domain.rowCount) return reply.code(500).send({ error:'maintenance_domain_missing' });
  const testContext = `admin_${role}_portal`;
  let actor = await pool.query(
    `select id from actors where actor_type=$1 and status='active' and attributes->>'testContext'=$2 order by created_at asc limit 1`,
    [role,testContext]
  );
  if (!actor.rowCount) {
    const displayName = role === 'tow' ? 'ROVIQ Admin Test Tow / Valet'
      : role === 'diagnostic' ? 'ROVIQ Admin Test Diagnostic'
      : role === 'parts' ? 'ROVIQ Admin Test Parts Vendor'
      : role === 'customer' ? 'ROVIQ Admin Test Customer'
      : 'ROVIQ Admin Test Partner';
    actor = await pool.query(
      `insert into actors(domain_id,actor_type,status,attributes) values($1,$2,'active',$3) returning id`,
      [domain.rows[0].id,role,JSON.stringify({ testContext, displayName })]
    );
  }
  const actorId = actor.rows[0].id as string;
  const principal = { role, actorId };
  const accessToken = await issueAccessToken(`admin-${role}-test:${actorId}`, principal);
  await audit(req.principal,`create_test_${role}_session`,'actor',actorId,'admin_testing_only');
  return { accessToken, tokenType:'Bearer', expiresIn:28800, principal, testing:true };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const b = loginBody.parse(req.body);
    const r = await pool.query('select id,actor_id,email,role,password_salt,password_hash,active from principal_identities where lower(email)=lower($1) limit 1',[b.email]);
    const identity = r.rows[0];
    if (!identity || !identity.active || !verifyPassword(b.password, identity.password_salt, identity.password_hash)) return reply.code(401).send({ error:'invalid_credentials' });
    const principal = { role: identity.role, actorId: identity.actor_id ?? undefined };
    const accessToken = await issueAccessToken(identity.id, principal);
    return { accessToken, tokenType:'Bearer', expiresIn:28800, principal:{ role:identity.role, actorId:identity.actor_id } };
  });

  app.post('/api/admin/testing/customer-session', { preHandler: requireRole('admin') }, async (req, reply) => adminTestSession(req,reply,'customer'));
  app.post('/api/admin/testing/partner-session', { preHandler: requireRole('admin') }, async (req, reply) => adminTestSession(req,reply,'partner'));
  app.post('/api/admin/testing/tow-session', { preHandler: requireRole('admin') }, async (req, reply) => adminTestSession(req,reply,'tow'));
  app.post('/api/admin/testing/diagnostic-session', { preHandler: requireRole('admin') }, async (req, reply) => adminTestSession(req,reply,'diagnostic'));
  app.post('/api/admin/testing/parts-session', { preHandler: requireRole('admin') }, async (req, reply) => adminTestSession(req,reply,'parts'));

  app.post('/api/admin/identities', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = createIdentityBody.parse(req.body);
    if (b.role === 'admin' && b.actorId) return reply.code(400).send({ error:'admin_identity_must_not_have_actor' });
    if (b.role !== 'admin' && !b.actorId) return reply.code(400).send({ error:'actor_required_for_non_admin' });
    const { salt, hash } = hashPassword(b.password);
    try {
      const r = await pool.query(`insert into principal_identities(actor_id,email,role,password_salt,password_hash) values($1,lower($2),$3,$4,$5) returning id,actor_id,email,role,active,created_at`,[b.actorId ?? null,b.email,b.role,salt,hash]);
      return reply.code(201).send({ identity:r.rows[0] });
    } catch (error:any) { if (error?.code === '23505') return reply.code(409).send({ error:'identity_email_exists' }); throw error; }
  });
}
