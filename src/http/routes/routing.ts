import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { audit } from '../../services/audit.js';
import { raiseException, transitionCase } from '../../services/orchestration.js';
import { routeMaintenanceDemand } from '../../services/routing.js';
import { autoDispatchCase } from '../../services/selection-authority.js';
import { requireRole } from '../middleware/principal.js';

export async function routingRoutes(app:FastifyInstance){
 app.post('/api/admin/demands/:id/route',{preHandler:requireRole('admin')},async(req,reply)=>{
  const{id}=req.params as{id:string};const body=z.object({createOffer:z.boolean().default(true)}).parse(req.body??{});
  try{
   const result=await routeMaintenanceDemand(id);
   const caseResult=await pool.query('select * from service_cases where demand_id=$1 order by created_at desc limit 1',[id]);
   let serviceCase=caseResult.rows[0]??null;
   if(serviceCase&&['triage','diagnostic_in_progress'].includes(serviceCase.state))serviceCase=await transitionCase(req.principal,serviceCase.id,'provider_selection',{source:'routing_engine'});
   let offer=null; let selection=null;
   const recommended=result.recommendedActorId??result.ranked[0]?.actorId??null;
   if(serviceCase&&recommended&&serviceCase.selection_mode==='auto_dispatch'){
    selection=await autoDispatchCase(serviceCase.id,recommended,result.decision?.id??null,{source:'routing_engine'});
   }
   // An offer is an invitation, not a provider selection. For customer/dealer choice,
   // the recommendation remains visible until the authorized selector chooses.
   if(body.createOffer&&recommended&&serviceCase?.selection_mode==='auto_dispatch'){
    const first=result.ranked[0];
    const r=await pool.query(`insert into matches_offers(demand_id,case_id,actor_id,score,rank,rule_basis) values($1,$2,$3,$4,1,$5) returning *`,[id,serviceCase?.id??null,recommended,first?.score??null,'coordination_recommendation_v2']);
    offer=r.rows[0];
    if(serviceCase?.state==='provider_selection')serviceCase=await transitionCase(req.principal,serviceCase.id,'provider_pending',{offerId:offer.id,providerActorId:recommended,selectionMode:'auto_dispatch'});
   }else if(serviceCase&&!recommended){await raiseException(serviceCase.id,'NO_ELIGIBLE_PROVIDER','No eligible provider found for the current service requirements.','warning',{demandId:id});}
   await audit(req.principal,'route_demand','demand_request',id,'coordination_recommendation_v2',{caseId:serviceCase?.id??null,recommendedActorId:recommended,selectedActorId:selection?.selectedActorId??null,selectionMode:serviceCase?.selection_mode??null,eligibleCount:result.ranked.length,rejectedCount:result.rejected.length});
   return{...result,case:serviceCase,offer,selection};
  }catch(error){if(error instanceof Error&&error.message==='demand_not_found')return reply.code(404).send({error:'demand_not_found'});throw error;}
 });
 app.get('/api/admin/demands/:id/routing-decisions',{preHandler:requireRole('admin')},async(req)=>{const{id}=req.params as{id:string};const r=await pool.query('select * from routing_decisions where demand_id=$1 order by evaluated_at desc',[id]);return{decisions:r.rows};});
}
