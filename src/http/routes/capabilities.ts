import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';

const body=z.object({
  capabilityKey:z.string().min(2).max(80),actorId:z.string().uuid().optional(),organizationId:z.string().uuid().optional(),
  connectorKey:z.string().min(2).max(120).optional(),status:z.enum(['active','inactive','degraded']).default('active'),
  operations:z.array(z.string()).default([]),geography:z.record(z.unknown()).default({}),metadata:z.record(z.unknown()).default({})
});
export async function capabilityRoutes(app:FastifyInstance){
  app.get('/api/core/capabilities',async(req)=>{
    const q=z.object({key:z.string().optional(),status:z.enum(['active','inactive','degraded']).default('active')}).parse(req.query??{});
    const params:unknown[]=[q.status];let sql='select id,capability_key,actor_id,organization_id,connector_key,status,operations,geography,metadata,health,updated_at from core_capabilities where status=$1';
    if(q.key){params.push(q.key);sql+=' and capability_key=$2';} sql+=' order by capability_key,updated_at desc limit 500';
    const r=await pool.query(sql,params);return{capabilities:r.rows};
  });
  app.post('/api/core/capabilities',{preHandler:requireRole('admin')},async(req,reply)=>{
    const b=body.parse(req.body);const r=await pool.query(`insert into core_capabilities(capability_key,actor_id,organization_id,connector_key,status,operations,geography,metadata)
      values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[b.capabilityKey,b.actorId??null,b.organizationId??null,b.connectorKey??null,b.status,b.operations,b.geography,b.metadata]);
    return reply.code(201).send({capability:r.rows[0]});
  });
}
