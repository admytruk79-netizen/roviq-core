import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';

export async function coreActorSurfaceRoutes(app:FastifyInstance){
  app.get('/api/core/me/cases',async(req,reply)=>{
    const q=z.object({
      state:z.string().max(80).optional(),
      caseType:z.enum(['maintenance','transport','mobility','fleet','trade']).optional(),
      limit:z.coerce.number().int().min(1).max(100).default(50)
    }).parse(req.query);
    if(req.principal.role==='admin')return reply.code(403).send({error:'use_operations_surface'});
    if(!req.principal.actorId)return reply.code(403).send({error:'actor_required'});
    const params:unknown[]=[req.principal.actorId];
    const clauses:string[]=[req.principal.role==='customer'?'c.customer_actor_id=$1':'c.current_owner_actor_id=$1'];
    if(q.state){params.push(q.state);clauses.push(`c.state=$${params.length}`);}
    if(q.caseType){params.push(q.caseType);clauses.push(`c.case_type=$${params.length}`);}
    params.push(q.limit);
    const r=await pool.query(`select c.*,
      (select count(*)::int from core_approvals a where a.case_id=c.id and a.state='pending') as pending_approvals,
      (select count(*)::int from core_sagas s where s.case_id=c.id and s.state not in ('completed','cancelled')) as active_workflows
      from core_cases c
      where ${clauses.join(' and ')}
      order by case when c.priority='urgent' then 0 when c.priority='high' then 1 else 2 end,c.updated_at desc
      limit $${params.length}`,params);
    return {cases:r.rows};
  });
}
