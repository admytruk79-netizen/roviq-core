import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { createServiceCase, transitionCase } from '../../services/orchestration.js';
import { requireRole } from '../middleware/principal.js';

const createDemand = z.object({
  domain: z.string().default('maintenance'),
  demandType: z.string().min(1),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  urgency: z.enum(['normal','urgent','emergency']).default('normal'),
  attributes: z.record(z.unknown()).default({})
});

export async function demandRoutes(app: FastifyInstance) {
  app.post('/api/demands', { preHandler: requireRole('customer','admin') }, async (req, reply) => {
    const body = createDemand.parse(req.body);
    const domain = await pool.query('select id from domains where code=$1 and status=$2', [body.domain, 'active']);
    if (!domain.rowCount) return reply.code(400).send({ error: 'unknown_domain' });

    const requester = req.principal.role === 'admin' ? null : req.principal.actorId;
    const result = await pool.query(
      `insert into demand_requests(domain_id, requester_actor_id, demand_type, location, urgency, attributes, state)
       values ($1,$2,$3,$4,$5,$6,'open') returning *`,
      [domain.rows[0].id, requester, body.demandType, body.location ? JSON.stringify(body.location) : null, body.urgency, JSON.stringify(body.attributes)]
    );
    const demand = result.rows[0];
    await audit(req.principal, 'create', 'demand_request', demand.id, 'customer_intake');

    if (body.domain === 'maintenance') {
      const priority = body.urgency === 'emergency' ? 'urgent' : body.urgency === 'urgent' ? 'high' : 'normal';
      const serviceCase = await createServiceCase(req.principal, {
        demandId:demand.id,
        priority,
        attributes:{ demandType:body.demandType, intakeLocation:body.location ?? null, ...body.attributes }
      });
      const triageCase = await transitionCase(req.principal,serviceCase.id,'triage',{ source:'customer_intake' });
      return reply.code(201).send({ demand, case:triageCase });
    }

    return reply.code(201).send({ demand });
  });

  app.get('/api/demands/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await pool.query('select * from demand_requests where id=$1', [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    const demand = r.rows[0];
    if (req.principal.role !== 'admin' && demand.requester_actor_id !== req.principal.actorId) {
      const assigned = await pool.query(
        `select 1 from matches_offers where demand_id=$1 and actor_id=$2 and outcome in ('offered','accepted') limit 1`,
        [id, req.principal.actorId]
      );
      if (!assigned.rowCount) return reply.code(403).send({ error: 'forbidden' });
    }
    return { demand };
  });
}
