import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';

const rule=z.object({
  policyCode:z.string().min(2).max(120),action:z.string().min(1).max(120),
  effect:z.enum(['allow','deny','require_review']),priority:z.number().int().min(-10000).max(10000).default(100),
  caseType:z.enum(['maintenance','transport','mobility','fleet','trade']).nullable().optional(),
  fromState:z.string().max(80).nullable().optional(),toState:z.string().max(80).nullable().optional(),
  actorRole:z.enum(['admin','customer','partner','diagnostic','tow','parts','fleet']).nullable().optional(),
  predicate:z.record(z.unknown()).default({}),reason:z.string().min(1).max(1000)
});
export async function policyRoutes(app:FastifyInstance){
  app.get('/api/core/policies',{preHandler:requireRole('admin')},async()=>({
    rules:(await pool.query('select * from core_policy_rules order by priority desc,created_at')).rows
  }));
  app.post('/api/core/policies',{preHandler:requireRole('admin')},async(req,reply)=>{
    const b=rule.parse(req.body);
    const r=await pool.query(`insert into core_policy_rules(policy_code,action,effect,priority,case_type,from_state,to_state,actor_role,predicate,reason)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [b.policyCode,b.action,b.effect,b.priority,b.caseType??null,b.fromState??null,b.toState??null,b.actorRole??null,b.predicate,b.reason]);
    return reply.code(201).send({rule:r.rows[0]});
  });
  app.patch('/api/core/policies/:id/enabled',{preHandler:requireRole('admin')},async(req,reply)=>{
    const {id}=req.params as {id:string};const b=z.object({enabled:z.boolean()}).parse(req.body);
    const r=await pool.query('update core_policy_rules set enabled=$2,updated_at=now() where id=$1 returning *',[id,b.enabled]);
    if(!r.rowCount)return reply.code(404).send({error:'policy_not_found'});return{rule:r.rows[0]};
  });
}
