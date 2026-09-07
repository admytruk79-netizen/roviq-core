import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { raiseException, transitionCase } from '../../services/orchestration.js';
import { routeMaintenanceDemand } from '../../services/routing.js';
import { autoDispatchCase } from '../../services/selection-authority.js';
import { assertAdminCaseScope, getAdminActorScope } from '../../services/admin-case-scope.js';
import { requireRole } from '../middleware/principal.js';

async function assertAdminDemandScope(principal:any,demandId:string){
  const scope=await getAdminActorScope(principal,pool);
  if(!scope)return;
  const c=await pool.query('select id from service_cases where demand_id=$1 order by created_at desc limit 1',[demandId]);
  if(!c.rowCount){
    const error=new Error('forbidden') as Error&{statusCode:number};error.statusCode=403;throw error;
  }
  await assertAdminCaseScope(principal,c.rows[0].id,pool);
}

export async function routingRoutes(app:FastifyInstance){
 app.post('/api/admin/demands/:id/route',{preHandler:requireRole('admin')},async(req,reply)=>{
  const{id}=req.params as{id:string};const body=z.object({createOffer:z.boolean().default(true)}).parse(req.body??{});
  try{
   await assertAdminDemandScope(req.principal,id);

   const before=await pool.query('select * from service_cases where demand_id=$1 order by created_at desc limit 1',[id]);
   const persisted=before.rows[0]??null;
   if(persisted?.selection_mode==='auto_dispatch'&&persisted.state==='provider_pending'&&persisted.selected_actor_id){
    return reply.code(409).send({error:'case_already_dispatched',caseId:persisted.id,selectedActorId:persisted.selected_actor_id,retryable:false});
   }

   // Auto-dispatch is only actionable when the selected provider receives an offer. Reject the
   // unsupported combination before routing or case-state mutation so selection, reservation and
   // provider visibility cannot diverge.
   if(!body.createOffer&&persisted?.selection_mode==='auto_dispatch'){
    return reply.code(400).send({error:'auto_dispatch_requires_offer'});
   }

   const result=await routeMaintenanceDemand(id);
   const caseResult=await pool.query('select * from service_cases where demand_id=$1 order by created_at desc limit 1',[id]);
   let serviceCase=caseResult.rows[0]??null;
   let offer=null; let selection:null|{caseId:string;selectedActorId:string;selectionMode:'auto_dispatch'}=null;
   const recommended=result.recommendedActorId??null;

   if(serviceCase&&['triage','diagnostic_in_progress'].includes(serviceCase.state))serviceCase=await transitionCase(req.principal,serviceCase.id,'provider_selection',{source:'routing_engine'});

   if(serviceCase&&recommended&&serviceCase.selection_mode==='auto_dispatch'){
    try{
     selection=await autoDispatchCase(serviceCase.id,recommended,result.decision?.id??null,{source:'routing_engine'});
    }catch(error){
     if(error instanceof Error&&error.message==='actor_not_serviceable'){
      await raiseException(serviceCase.id,'PROVIDER_CAPACITY_CHANGED','Recommended provider capacity changed before auto-dispatch could commit.','warning',{demandId:id,recommendedActorId:recommended});
      return reply.code(409).send({error:'provider_capacity_changed',recommendedActorId:recommended,retryable:true});
     }
     if(error instanceof Error&&error.message==='case_not_selectable'){
      const current=await pool.query('select state,selected_actor_id from service_cases where id=$1',[serviceCase.id]);
      return reply.code(409).send({error:'case_already_dispatched',caseId:serviceCase.id,state:current.rows[0]?.state??null,selectedActorId:current.rows[0]?.selected_actor_id??null,retryable:false});
     }
     throw error;
    }
   }

   if(body.createOffer&&recommended&&serviceCase?.selection_mode==='auto_dispatch'){
    const first=result.ranked[0] as {score?:number}|undefined;
    const r=await pool.query(`insert into matches_offers(demand_id,case_id,actor_id,score,rank,rule_basis) values($1,$2,$3,$4,1,$5) returning *`,[id,serviceCase?.id??null,recommended,first?.score??null,'coordination_recommendation_v2']);
    offer=r.rows[0];
    if(serviceCase?.state==='provider_selection')serviceCase=await transitionCase(req.principal,serviceCase.id,'provider_pending',{offerId:offer.id,providerActorId:recommended,selectionMode:'auto_dispatch'});
   }else if(serviceCase&&!recommended){await raiseException(serviceCase.id,'NO_ELIGIBLE_PROVIDER','No eligible provider found for the current service requirements.','warning',{demandId:id});}
   await audit(req.principal,'route_demand','demand_request',id,'coordination_recommendation_v2',{caseId:serviceCase?.id??null,recommendedActorId:recommended,selectedActorId:selection?.selectedActorId??null,selectionMode:serviceCase?.selection_mode??null,eligibleCount:result.ranked.length,rejectedCount:result.rejected.length});
   return{...result,case:serviceCase,offer,selection};
  }catch(error){if(error instanceof Error&&error.message==='demand_not_found')return reply.code(404).send({error:'demand_not_found'});throw error;}
 });
 app.get('/api/admin/demands/:id/routing-decisions',{preHandler:requireRole('admin')},async(req)=>{const{id}=req.params as{id:string};await assertAdminDemandScope(req.principal,id);const r=await pool.query('select * from routing_decisions where demand_id=$1 order by evaluated_at desc',[id]);return{decisions:r.rows};});
}
