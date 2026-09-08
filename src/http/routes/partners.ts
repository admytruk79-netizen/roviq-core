import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { transitionCase } from '../../services/orchestration.js';
import { publishIntegrationEvent } from '../../services/integration-gateway.js';
import { confirmCaseCapacity, releaseCaseCapacity } from '../../services/capacity-reservation.js';
import { requireRole } from '../middleware/principal.js';

const capacityBody = z.object({
  capacityType: z.string().min(1), quantity: z.number().nonnegative(), startAt: z.string().datetime(), endAt: z.string().datetime(), source: z.string().default('partner_declared')
});

const controlsBody = z.object({
  routingEnabled: z.boolean().default(true),
  acceptsOverflow: z.boolean().default(false),
  releasesOverflow: z.boolean().default(false),
  serviceRadiusMiles: z.number().positive().nullable().optional(),
  operatingHours: z.record(z.unknown()).default({}),
  acceptedJobTypes: z.array(z.string()).default([]),
  excludedJobTypes: z.array(z.string()).default([]),
  oemWarrantyRules: z.record(z.unknown()).default({}),
  maxActiveJobs: z.number().int().nonnegative().nullable().optional(),
  earliestAvailableAt: z.string().datetime().nullable().optional(),
  loanerParticipation: z.boolean().default(false),
  valetParticipation: z.boolean().default(false),
  towParticipation: z.boolean().default(false)
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

  app.get('/api/partners/me/controls', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const r = await pool.query('select * from partner_controls where actor_id=$1', [req.principal.actorId]);
    return { controls: r.rows[0] ?? null };
  });

  app.patch('/api/partners/me/controls', { preHandler: requireRole('partner','diagnostic','tow','parts','fleet') }, async (req) => {
    const b = controlsBody.parse(req.body);
    const r = await pool.query(
      `insert into partner_controls(actor_id,routing_enabled,accepts_overflow,releases_overflow,service_radius_miles,
        operating_hours_json,accepted_job_types_json,excluded_job_types_json,oem_warranty_rules_json,max_active_jobs,
        earliest_available_at,loaner_participation,valet_participation,tow_participation,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       on conflict(actor_id) do update set routing_enabled=excluded.routing_enabled, accepts_overflow=excluded.accepts_overflow,
        releases_overflow=excluded.releases_overflow, service_radius_miles=excluded.service_radius_miles,
        operating_hours_json=excluded.operating_hours_json, accepted_job_types_json=excluded.accepted_job_types_json,
        excluded_job_types_json=excluded.excluded_job_types_json, oem_warranty_rules_json=excluded.oem_warranty_rules_json,
        max_active_jobs=excluded.max_active_jobs, earliest_available_at=excluded.earliest_available_at,
        loaner_participation=excluded.loaner_participation, valet_participation=excluded.valet_participation,
        tow_participation=excluded.tow_participation, updated_at=now() returning *`,
      [req.principal.actorId,b.routingEnabled,b.acceptsOverflow,b.releasesOverflow,b.serviceRadiusMiles ?? null,
       JSON.stringify(b.operatingHours),JSON.stringify(b.acceptedJobTypes),JSON.stringify(b.excludedJobTypes),JSON.stringify(b.oemWarrantyRules),
       b.maxActiveJobs ?? null,b.earliestAvailableAt ?? null,b.loanerParticipation,b.valetParticipation,b.towParticipation]
    );
    await audit(req.principal,'update_partner_controls','partner_controls',req.principal.actorId!,'actor_owned_controls');
    return { controls:r.rows[0] };
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

    if (body.outcome === 'declined') {
      const client=await pool.connect();
      try{
        await client.query('begin');
        const offerIdentity=await client.query(
          `select id,case_id from matches_offers where id=$1 and actor_id=$2`,
          [id,req.principal.actorId]
        );
        if(!offerIdentity.rowCount){
          await client.query('rollback');
          return reply.code(404).send({error:'offer_not_found_or_not_owned'});
        }
        const caseId=offerIdentity.rows[0].case_id as string|null;

        let serviceCase=null;
        if(caseId){
          const caseResult=await client.query('select * from service_cases where id=$1 for update',[caseId]);
          if(!caseResult.rowCount){
            await client.query('rollback');
            return reply.code(409).send({error:'offer_case_missing'});
          }
          serviceCase=caseResult.rows[0];
        }

        const offerResult=await client.query(
          `select * from matches_offers where id=$1 and actor_id=$2 for update`,
          [id,req.principal.actorId]
        );
        if(!offerResult.rowCount){
          await client.query('rollback');
          return reply.code(404).send({error:'offer_not_found_or_not_owned'});
        }
        const offer=offerResult.rows[0];
        if(offer.outcome!=='offered'||offer.case_id!==caseId){
          await client.query('rollback');
          return reply.code(409).send({error:'offer_already_responded'});
        }

        const declined=(await client.query(
          `update matches_offers set outcome='declined',responded_at=now()
           where id=$1 and actor_id=$2 and outcome='offered' returning *`,
          [id,req.principal.actorId]
        )).rows[0];
        if(!declined){
          await client.query('rollback');
          return reply.code(409).send({error:'offer_already_responded'});
        }

        if(caseId&&serviceCase){
          if(serviceCase.state==='provider_pending'&&serviceCase.selected_actor_id===req.principal.actorId){
            await releaseCaseCapacity(caseId,client);
            const updated=await client.query(`
              update service_cases
                 set state='provider_selection',
                     selected_actor_id=null,
                     selection_source=null,
                     selected_at=null,
                     version=version+1,
                     updated_at=now()
               where id=$1 and state='provider_pending' and selected_actor_id=$2
               returning *`,[caseId,req.principal.actorId]);
            if(!updated.rowCount) throw new Error('case_not_selectable');
            serviceCase=updated.rows[0];
            await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
              values('service_case',$1,'PROVIDER_DECLINED',$2,$3),
                    ('service_case',$1,'CASE_PROVIDER_SELECTION',$2,$4)`,[
              caseId,req.principal.actorId,
              JSON.stringify({offerId:id,actorId:req.principal.actorId,from:'provider_pending'}),
              JSON.stringify({from:'provider_pending',to:'provider_selection',declinedOfferId:id,declinedActorId:req.principal.actorId})
            ]);
          }else{
            await client.query(`insert into case_exceptions(case_id,exception_code,severity,summary,metadata)
              values($1,'OFFER_DECLINED','warning',$2,$3)`,[
              caseId,`${req.principal.role} declined an assigned offer.`,JSON.stringify({offerId:id,actorId:req.principal.actorId})
            ]);
          }
        }
        await client.query('commit');
        await audit(req.principal,'respond_offer','match_offer',id,'actor_scoped_offer',{outcome:'declined',caseId:caseId??null});
        return {offer:declined,case:serviceCase};
      }catch(error){
        await client.query('rollback');
        throw error;
      }finally{client.release();}
    }

    if(req.principal.role==='partner'){
      const client=await pool.connect();
      let committedCaseId:string|null=null;
      let acceptedOffer:any=null;
      let acceptedCase:any=null;
      try{
        await client.query('begin');
        const offerIdentity=await client.query(
          `select id,case_id from matches_offers where id=$1 and actor_id=$2`,
          [id,req.principal.actorId]
        );
        if(!offerIdentity.rowCount){
          await client.query('rollback');
          return reply.code(404).send({error:'offer_not_found_or_not_owned'});
        }
        const caseId=offerIdentity.rows[0].case_id as string|null;
        if(!caseId){
          await client.query('rollback');
          return reply.code(409).send({error:'offer_case_missing'});
        }

        const caseResult=await client.query('select * from service_cases where id=$1 for update',[caseId]);
        if(!caseResult.rowCount){
          await client.query('rollback');
          return reply.code(409).send({error:'offer_case_missing'});
        }

        const offerResult=await client.query(
          `select * from matches_offers where id=$1 and actor_id=$2 for update`,
          [id,req.principal.actorId]
        );
        if(!offerResult.rowCount||offerResult.rows[0].outcome!=='offered'||offerResult.rows[0].case_id!==caseId){
          await client.query('rollback');
          return reply.code(404).send({error:'offer_not_found_or_not_owned'});
        }
        const current=caseResult.rows[0];
        if(current.state!=='provider_pending'||current.selected_actor_id!==req.principal.actorId){
          await client.query('rollback');
          return reply.code(409).send({error:'offer_not_current_selection'});
        }

        const transition=await client.query(
          `select allowed_roles from case_transition_rules where from_state='provider_pending' and to_state='repair_in_progress'`
        );
        if(!transition.rowCount||!transition.rows[0].allowed_roles.includes(req.principal.role)){
          await client.query('rollback');
          return reply.code(409).send({error:'offer_accept_transition_not_allowed'});
        }

        acceptedOffer=(await client.query(
          `update matches_offers set outcome='accepted',responded_at=now()
           where id=$1 and actor_id=$2 and outcome='offered' returning *`,
          [id,req.principal.actorId]
        )).rows[0];
        if(!acceptedOffer) throw new Error('offer_already_responded');

        await client.query(`
          update matches_offers set outcome='declined',responded_at=coalesce(responded_at,now())
          where case_id=$1 and id<>$2 and outcome='offered'`,[caseId,id]);

        await confirmCaseCapacity(caseId,client);

        const updated=await client.query(`
          update service_cases
             set state='repair_in_progress',version=version+1,updated_at=now()
           where id=$1 and state='provider_pending' and selected_actor_id=$2
           returning *`,[caseId,req.principal.actorId]);
        if(!updated.rowCount) throw new Error('offer_not_current_selection');
        acceptedCase=updated.rows[0];

        const integrationPayload={from:'provider_pending',to:'repair_in_progress',offerId:id,providerActorId:req.principal.actorId};
        await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
          values('service_case',$1,'PROVIDER_ACCEPTED',$2,$3),
                ('service_case',$1,'CASE_REPAIR_IN_PROGRESS',$2,$4)`,[
          caseId,req.principal.actorId,
          JSON.stringify({offerId:id,actorId:req.principal.actorId,from:'provider_pending'}),
          JSON.stringify(integrationPayload)
        ]);
        await publishIntegrationEvent({
          aggregateType:'service_case',
          aggregateId:caseId,
          eventType:'CASE_REPAIR_IN_PROGRESS',
          actorId:req.principal.actorId ?? undefined,
          payload:integrationPayload
        },client);
        await client.query('commit');
        committedCaseId=caseId;
      }catch(error){
        await client.query('rollback');
        throw error;
      }finally{client.release();}

      await audit(req.principal,'respond_offer','match_offer',id,'actor_scoped_offer',{outcome:'accepted',caseId:committedCaseId});
      return {offer:acceptedOffer,case:acceptedCase};
    }

    const r = await pool.query(
      `update matches_offers set outcome=$1, responded_at=now()
       where id=$2 and actor_id=$3 and outcome='offered' returning *`,
      [body.outcome,id,req.principal.actorId]
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'offer_not_found_or_not_owned' });
    const offer = r.rows[0];

    let serviceCase = null;
    if (offer.case_id) {
      const c = await pool.query('select * from service_cases where id=$1',[offer.case_id]);
      serviceCase = c.rows[0] ?? null;
      if (serviceCase && body.outcome === 'accepted') {
        await pool.query('update service_cases set current_owner_role=$1,current_owner_actor_id=$2,updated_at=now() where id=$3',[req.principal.role,req.principal.actorId,offer.case_id]);
        const target = req.principal.role === 'diagnostic' ? 'diagnostic_in_progress' : req.principal.role === 'tow' ? 'tow_in_progress' : req.principal.role === 'parts' ? 'repair_in_progress' : 'repair_in_progress';
        try { serviceCase = await transitionCase(req.principal,offer.case_id,target); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== 'invalid_case_transition' && message !== 'transition_forbidden') {
            console.error('offer_accept_transition_unexpected_error', { caseId: offer.case_id, target, message });
          }
        }
      }
    }

    await audit(req.principal,'respond_offer','match_offer',id,'actor_scoped_offer',{ outcome: body.outcome, caseId:offer.case_id ?? null });
    return { offer, case:serviceCase };
  });
}
