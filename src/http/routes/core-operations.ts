import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';

async function adminScope(actorId?:string){
  if(!actorId)return null;
  const r=await pool.query('select organization_id,location_id,status from actors where id=$1',[actorId]);
  if(!r.rowCount||r.rows[0].status!=='active'||!r.rows[0].organization_id)throw new Error('forbidden');
  return {organizationId:r.rows[0].organization_id as string,locationId:r.rows[0].location_id as string|null};
}
function whereScope(scope:{organizationId:string;locationId:string|null}|null,start:number){
  if(!scope)return {sql:'',params:[] as unknown[]};
  return {
    sql:` and exists(select 1 from actors owner where owner.id=c.current_owner_actor_id and owner.organization_id=$${start} and ($${start+1}::uuid is null or owner.location_id=$${start+1}))`,
    params:[scope.organizationId,scope.locationId]
  };
}

export async function coreOperationsRoutes(app:FastifyInstance){
  app.get('/api/core/operations/cases',{preHandler:requireRole('admin')},async(req,reply)=>{
    try{
      const q=z.object({
        state:z.string().max(80).optional(),
        caseType:z.enum(['maintenance','transport','mobility','fleet','trade']).optional(),
        limit:z.coerce.number().int().min(1).max(200).default(100)
      }).parse(req.query);
      const scope=await adminScope(req.principal.actorId);
      const params:unknown[]=[];const clauses:string[]=['1=1'];
      if(q.state){params.push(q.state);clauses.push(`c.state=$${params.length}`);}
      if(q.caseType){params.push(q.caseType);clauses.push(`c.case_type=$${params.length}`);}
      const s=whereScope(scope,params.length+1);params.push(...s.params);
      params.push(q.limit);
      const rows=await pool.query(`select c.*,
        (select count(*)::int from core_sagas s where s.case_id=c.id and s.state not in ('completed','cancelled')) as open_sagas,
        (select count(*)::int from core_approvals a where a.case_id=c.id and a.state='pending') as pending_approvals,
        (select max(occurred_at) from core_case_events e where e.case_id=c.id) as last_event_at
        from core_cases c where ${clauses.join(' and ')} ${s.sql}
        order by case
          when c.priority='urgent' then 0 when c.priority='high' then 1 when c.priority='normal' then 2 else 3 end,
          c.updated_at desc
        limit $${params.length}`,params);
      return {cases:rows.rows};
    }catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
  });

  app.get('/api/core/operations/command-center',{preHandler:requireRole('admin')},async(req,reply)=>{
    try{
      const scope=await adminScope(req.principal.actorId);
      const s=whereScope(scope,1);
      const caseParams=s.params;
      const [summary,exceptions,approvals,outbox,inbox]=await Promise.all([
        pool.query(`select
          count(*)::int as total,
          count(*) filter(where c.state not in ('completed','cancelled','expired'))::int as active,
          count(*) filter(where c.priority in ('high','urgent') and c.state not in ('completed','cancelled','expired'))::int as priority_watch,
          count(*) filter(where c.state in ('waiting_external','needs_review','blocked','retry_scheduled','degraded','failed'))::int as attention,
          count(*) filter(where c.case_type='trade' and c.state not in ('completed','cancelled','expired'))::int as active_trade
          from core_cases c where 1=1 ${s.sql}`,caseParams),
        pool.query(`select c.id,c.case_type,c.state,c.priority,c.updated_at
          from core_cases c where c.state in ('needs_review','blocked','degraded','failed','waiting_external') ${s.sql}
          order by case when c.state='failed' then 0 when c.state='blocked' then 1 when c.state='needs_review' then 2 else 3 end,c.updated_at
          limit 20`,caseParams),
        pool.query(`select count(*)::int as count from core_approvals a
          join core_cases c on c.id=a.case_id where a.state='pending' ${s.sql}`,caseParams),
        pool.query(`select count(*)::int as count from core_outbox where published_at is null and available_at<=now()`),
        pool.query(`select count(*)::int as count from core_connector_inbox where status='failed'`)
      ]);
      return {
        summary:{...summary.rows[0],pendingApprovals:approvals.rows[0].count,outboxReady:outbox.rows[0].count,failedIntegrations:inbox.rows[0].count},
        attentionCases:exceptions.rows
      };
    }catch(e){if(e instanceof Error&&e.message==='forbidden')return reply.code(403).send({error:'forbidden'});throw e;}
  });
}
