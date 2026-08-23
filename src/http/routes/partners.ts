import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { requireRole } from '../middleware/principal.js';

const capacityBody = z.object({
  capacityType: z.string().min(1), quantity: z.number().nonnegative(), startAt: z.string().datetime(), endAt: z.string().datetime(), source: z.string().default('partner_declared')
});

export async function partnerRoutes(app: FastifyInstance) {
  app.get('/api/partners/me/capacity', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query('select * from capacity_snapshots where actor_id=$1 order by start_at desc limit 100', [req.principal.actorId]);
    return { capacity: r.rows };
  });

  app.patch('/api/partners/me/capacity', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req, reply) => {
    const b = capacityBody.parse(req.body);
    const r = await pool.query(
      `insert into capacity_snapshots(actor_id, capacity_type, quantity, start_at, end_at, source, confidence)
       values($1,$2,$3,$4,$5,$6,1) returning *`,
      [req.principal.actorId,b.capacityType,b.quantity,b.startAt,b.endAt,b.source]
    );
    await audit(req.principal,'declare_capacity','capacity_snapshot',r.rows[0].id,'actor_owned_capacity');
    return reply.code(201).send({ capacity: r.rows[0] });
  });

  app.get('/api/partners/me/offers', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query(
      `select m.*, d.demand_type, d.urgency, d.attributes from matches_offers m
       join demand_requests d on d.id=m.demand_id where m.actor_id=$1 order by m.offered_at desc`,
      [req.principal.actorId]
    );
    return { offers: r.rows };
  });

  app.post('/api/offers/:id/respond', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ outcome: z.enum(['accepted','declined']) }).parse(req.body);
    const r = await pool.query(
      `update matches_offers set outcome=$1, responded_at=now()
       where id=$2 and actor_id=$3 and outcome='offered' returning *`,
      [body.outcome,id,req.principal.actorId]
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'offer_not_found_or_not_owned' });
    await audit(req.principal,'respond_offer','match_offer',id,'actor_scoped_offer',{ outcome: body.outcome });
    return { offer: r.rows[0] };
  });
}
