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

async function ensurePartnerTestReadiness(actorId:string, domainId:string) {
  const client=await pool.connect();
  try {
    await client.query('begin');
    const actor=await client.query('select location_id from actors where id=$1 for update',[actorId]);
    if(!actor.rowCount) throw new Error('test_partner_missing');

    let locationId=actor.rows[0].location_id as string|null;
    if(!locationId){
      const existingLocation=await client.query(
        `select id from locations where metadata->>'testContext'='admin_partner_portal' order by created_at asc limit 1`
      );
      if(existingLocation.rowCount){
        locationId=existingLocation.rows[0].id;
      }else{
        const location=await client.query(
          `insert into locations(name,address,latitude,longitude,country_code,region,city,metadata)
           values('ROVIQ Admin Test Repair Partner','ROVIQ production acceptance repair destination',45.5231,-122.6819,'US','OR','Portland',$1)
           returning id`,
          [JSON.stringify({testContext:'admin_partner_portal',purpose:'production_acceptance'})]
        );
        locationId=location.rows[0].id;
      }
      await client.query('update actors set location_id=$2 where id=$1',[actorId,locationId]);
    }

    await client.query(
      `insert into actor_capabilities(actor_id,capability_id,active)
       select $1,c.id,true from capabilities c where c.domain_id=$2 and c.capability_code='repair'
       on conflict(actor_id,capability_id) do update set active=true`,
      [actorId,domainId]
    );
    await client.query(
      `insert into partner_controls(actor_id,routing_enabled,accepts_overflow,accepted_job_types_json,excluded_job_types_json,earliest_available_at,updated_at)
       values($1,true,true,'[]'::jsonb,'[]'::jsonb,now(),now())
       on conflict(actor_id) do update
         set routing_enabled=true,
             accepts_overflow=true,
             accepted_job_types_json='[]'::jsonb,
             excluded_job_types_json='[]'::jsonb,
             earliest_available_at=now(),
             updated_at=now()`,
      [actorId]
    );
    await client.query(
      `insert into capacity_snapshots(actor_id,capacity_type,quantity,start_at,end_at,source,confidence)
       select $1,'repair',4,now()-interval '1 hour',now()+interval '24 hours','admin_testing_only',1
       where not exists(
         select 1 from capacity_snapshots
          where actor_id=$1
            and source='admin_testing_only'
            and capacity_type='repair'
            and quantity>0
            and start_at<=now()
            and end_at>now()+interval '1 hour'
       )`,
      [actorId]
    );
    await client.query('commit');
  } catch(error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

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
  if(role==='partner') await ensurePartnerTestReadiness(actorId,domain.rows[0].id as string);
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
