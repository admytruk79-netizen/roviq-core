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

  app.get('/api/admin/actors', { preHandler: requireRole('admin') }, async (req) => {
    const query = z.object({
      actorType: z.string().min(1).optional(),
      domain: z.string().min(1).optional(),
      status: z.string().min(1).optional()
    }).parse(req.query ?? {});
    const r = await pool.query(
      `select a.id,a.actor_type,a.status,a.attributes,d.code as domain,a.created_at
       from actors a
       left join domains d on d.id=a.domain_id
       where ($1::text is null or a.actor_type=$1)
         and ($2::text is null or d.code=$2)
         and ($3::text is null or a.status=$3)
       order by a.created_at asc`,
      [query.actorType ?? null,query.domain ?? null,query.status ?? null]
    );
    return { actors:r.rows };
  });

  app.post('/api/admin/offers', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({ demandId:z.string().uuid(), actorId:z.string().uuid(), resourceId:z.string().uuid().optional(), rank:z.number().int().positive().default(1), score:z.number().optional(), ruleBasis:z.string().default('manual_dispatch') }).parse(req.body);
    const client=await pool.connect();
    let offer:any;
    let caseId:string|null=null;
    try{
      await client.query('begin');
      const caseResult = await client.query(
        'select * from service_cases where demand_id=$1 order by created_at desc limit 1 for update',
        [body.demandId]
      );
      const serviceCase=caseResult.rows[0]??null;
      caseId=serviceCase?.id??null;

      const actor=await client.query(`select a.id,a.actor_type,a.status,
        exists(select 1 from actor_capabilities ac join capabilities c on c.id=ac.capability_id where ac.actor_id=a.id and c.capability_code='repair') as can_repair
        from actors a where a.id=$1`,[body.actorId]);
      if(!actor.rowCount||actor.rows[0].status!=='active'){
        await client.query('rollback');
        return reply.code(409).send({error:'offer_actor_unavailable'});
      }

      const r = await client.query(
        `insert into matches_offers(demand_id,case_id,actor_id,resource_id,score,rank,rule_basis,outcome)
         values($1,$2,$3,$4,$5,$6,$7,'offered') returning *`,
        [body.demandId,caseId,body.actorId,body.resourceId ?? null,body.score ?? null,body.rank,body.ruleBasis]
      );
      offer=r.rows[0];

      // A manual repair offer created while the case is awaiting provider selection is
      // itself the authoritative admin selection. Advance the case atomically so only
      // that selected provider can accept it. Diagnostic/tow/parts offer workflows keep
      // their existing role-specific transitions.
      if(serviceCase?.state==='provider_selection'&&actor.rows[0].can_repair){
        if(serviceCase.selected_actor_id&&serviceCase.selected_actor_id!==body.actorId){
          throw Object.assign(new Error('case_selection_conflict'),{statusCode:409});
        }
        await client.query(`update service_cases
          set selected_actor_id=$1,selection_source='ops_override',selected_at=coalesce(selected_at,now()),
              state='provider_pending',version=version+1,updated_at=now()
          where id=$2 and state='provider_selection' and (selected_actor_id is null or selected_actor_id=$1)`,[body.actorId,caseId]);
        await client.query(`update matches_offers
          set outcome='declined',responded_at=coalesce(responded_at,now())
          where case_id=$1 and id<>$2 and outcome='offered'`,[caseId,offer.id]);
        await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
          values('service_case',$1,'PROVIDER_SELECTED',$2,$3),
                ('service_case',$1,'CASE_PROVIDER_PENDING',$2,$4)`,[
          caseId,req.principal.actorId??null,
          JSON.stringify({actorId:body.actorId,selectionMode:'ops_override',offerId:offer.id,ruleBasis:body.ruleBasis}),
          JSON.stringify({from:'provider_selection',to:'provider_pending',providerActorId:body.actorId,offerId:offer.id,selectionMode:'ops_override'})
        ]);
      }
      await client.query('commit');
    }catch(error){
      await client.query('rollback');
      throw error;
    }finally{client.release();}
    await audit(req.principal,'create_offer','match_offer',offer.id,body.ruleBasis,{ demandId:body.demandId, caseId, actorId:body.actorId });
    return reply.code(201).send({ offer });
  });

  app.post('/api/admin/routing-policies', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = z.object({
      domain:z.string().min(1).default('maintenance'),
      policyKey:z.string().min(1).default('maintenance_default'),
      version:z.number().int().positive(),
      configuration:z.record(z.unknown()),
      activate:z.boolean().default(true)
    }).parse(req.body);

    const domain = await pool.query('select id from domains where code=$1',[body.domain]);
    if (!domain.rowCount) return reply.code(400).send({ error:'unknown_domain' });

    const client = await pool.connect();
    try {
      await client.query('begin');
      if (body.activate) {
        await client.query(
          'update routing_policies set active=false,updated_at=now() where domain_id=$1 and policy_key=$2 and active=true',
          [domain.rows[0].id,body.policyKey]
        );
      }
      const r = await client.query(
        `insert into routing_policies(domain_id,policy_key,version,active,configuration)
         values($1,$2,$3,$4,$5)
         on conflict(domain_id,policy_key,version)
         do update set active=excluded.active,configuration=excluded.configuration,updated_at=now()
         returning id,domain_id,policy_key,version,active,created_at,updated_at`,
        [domain.rows[0].id,body.policyKey,body.version,body.activate,JSON.stringify(body.configuration)]
      );
      await client.query('commit');
      await audit(req.principal,'upsert_routing_policy','routing_policy',r.rows[0].id,`${body.policyKey}:v${body.version}`,{ domain:body.domain, active:body.activate });
      return reply.code(201).send({ policy:r.rows[0] });
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally { client.release(); }
  });

  app.get('/api/admin/routing-policies', { preHandler: requireRole('admin') }, async (req) => {
    const query = z.object({ domain:z.string().optional(), policyKey:z.string().optional() }).parse(req.query ?? {});
    const r = await pool.query(
      `select rp.id,d.code as domain,rp.policy_key,rp.version,rp.active,rp.created_at,rp.updated_at
       from routing_policies rp join domains d on d.id=rp.domain_id
       where ($1::text is null or d.code=$1) and ($2::text is null or rp.policy_key=$2)
       order by d.code,rp.policy_key,rp.version desc`,
      [query.domain ?? null,query.policyKey ?? null]
    );
    return { policies:r.rows };
  });

  app.get('/api/admin/audit', { preHandler: requireRole('admin') }, async () => {
    const r = await pool.query('select * from audit_log order by occurred_at desc limit 500');
    return { audit: r.rows };
  });
}