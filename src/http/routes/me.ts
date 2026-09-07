import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';

// E.164: a leading '+', a non-zero first digit, up to 15 digits total -- the format Twilio (and
// SMS in general) requires. No formatting/normalization attempted here: asking the caller to send
// a correctly-formatted number is simpler and more predictable than guessing at country codes.
const E164 = /^\+[1-9]\d{7,14}$/;

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
}
