import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';

// E.164: a leading '+', a non-zero first digit, up to 15 digits total -- the format Twilio (and
// SMS in general) requires. No formatting/normalization attempted here: asking the caller to send
// a correctly-formatted number is simpler and more predictable than guessing at country codes.
const E164 = /^\+[1-9]\d{7,14}$/;

const pushRoles = ['customer','partner','diagnostic','tow','parts','fleet'] as const;

// Matches browser PushSubscription.toJSON() exactly, so the frontend can POST what
// registration.pushManager.subscribe() returned with no reshaping.
const pushSubscriptionSchema = z.object({
  endpoint:z.string().url(),
  keys:z.object({ p256dh:z.string().min(1), auth:z.string().min(1) })
});

export async function meRoutes(app:FastifyInstance) {
  // Every non-admin role can set its own phone number -- this is what makes the 'sms' notification
  // channel (setCustomerSnapshot in operations.ts, the 'twilio' adapter in notifications.ts)
  // actually reachable for that actor. Admin has no actor_id, so there is nothing to attach a
  // phone number to.
  app.get('/api/me/phone', { preHandler:requireRole('customer','partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query('select phone from actors where id=$1',[req.principal.actorId]);
    return { phone:r.rows[0]?.phone ?? null };
  });

  app.put('/api/me/phone', { preHandler:requireRole('customer','partner','diagnostic','tow','parts','fleet') }, async (req, reply) => {
    const body = z.object({ phone:z.string().regex(E164,'phone_must_be_e164') }).parse(req.body);
    try {
      const r = await pool.query('update actors set phone=$1 where id=$2 returning phone',[body.phone,req.principal.actorId]);
      if (!r.rowCount) return reply.code(404).send({ error:'actor_not_found' });
      return { phone:r.rows[0].phone };
    } catch (error) {
      if ((error as { code?:string }).code === '23505') return reply.code(409).send({ error:'phone_already_in_use' });
      throw error;
    }
  });

  // The VAPID public key is not secret (it's handed to every subscribed browser via
  // Crypto-Key/applicationServerKey), just not worth exposing unauthenticated.
  app.get('/api/me/push-public-key', { preHandler:requireRole(...pushRoles) }, async (_req, reply) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!publicKey) return reply.code(404).send({ error:'webpush_not_configured' });
    return { publicKey };
  });

  app.post('/api/me/push-subscriptions', { preHandler:requireRole(...pushRoles) }, async (req, reply) => {
    const body = pushSubscriptionSchema.parse(req.body);
    await pool.query(
      `insert into push_subscriptions(actor_id,endpoint,p256dh,auth,user_agent)
       values($1,$2,$3,$4,$5)
       on conflict(endpoint) do update set actor_id=excluded.actor_id,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent,updated_at=now()`,
      [req.principal.actorId,body.endpoint,body.keys.p256dh,body.keys.auth,typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null]
    );
    return reply.code(201).send({ subscribed:true });
  });

  app.delete('/api/me/push-subscriptions', { preHandler:requireRole(...pushRoles) }, async (req) => {
    const body = z.object({ endpoint:z.string().url() }).parse(req.body);
    await pool.query('delete from push_subscriptions where endpoint=$1 and actor_id=$2',[body.endpoint,req.principal.actorId]);
    return { subscribed:false };
  });
}
