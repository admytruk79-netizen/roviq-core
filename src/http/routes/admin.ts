import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { requireRole } from '../middleware/principal.js';

export async function adminRoutes(app: FastifyInstance) {
  app.post('/api/admin/actors', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ actorType: z.string().min(1), legalEntityId: z.string().optional(), domain: z.string().optional(), attributes: z.record(z.unknown()).default({}) }).parse(req.body);
    let domainId = null;
    if (body.domain) {
      const d = await pool.query('select id from domains where code=$1',[body.domain]);
      if (!d.rowCount) return reply.code(400).send({ error:'unknown_domain' });
      domainId = d.rows[0].id;
    }
    const r = await pool.query(
      `insert into actors(domain_id,actor_type,legal_entity_id,status,attributes) values($1,$2,$3,'active',$4) returning *`,
      [domainId,body.actorType,body.legalEntityId ?? null,JSON.stringify(body.attributes)]
    );
    await audit(req.principal,'create','actor',r.rows[0].id,'admin_actor_registry');
    return reply.code(201).send({ actor:r.rows[0] });
  });

  app.post('/api/admin/offers', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ demandId:z.string().uuid(), actorId:z.string().uuid(), resourceId:z.string().uuid().optional(), rank:z.number().int().positive().default(1), score:z.number().optional(), ruleBasis:z.string().default('manual_dispatch') }).parse(req.body);
    const r = await pool.query(
      `insert into matches_offers(demand_id,actor_id,resource_id,score,rank,rule_basis,outcome)
       values($1,$2,$3,$4,$5,$6,'offered') returning *`,
      [body.demandId,body.actorId,body.resourceId ?? null,body.score ?? null,body.rank,body.ruleBasis]
    );
    await audit(req.principal,'create_offer','match_offer',r.rows[0].id,body.ruleBasis,{ demandId:body.demandId, actorId:body.actorId });
    return reply.code(201).send({ offer:r.rows[0] });
  });

  app.get('/api/admin/audit', { preHandler: requireRole('admin') }, async () => {
    const r = await pool.query('select * from audit_log order by occurred_at desc limit 500');
    return { audit: r.rows };
  });
}
