import { pool } from '../db/pool.js';
import { COORDINATION_ENGINE_VERSION, rankCoordinationCandidates } from './coordination-engine.js';
import { capabilityFromCaseIntelligence, loadCaseIntelligenceForDemand } from './case-intelligence.js';
import { recordRecommendation } from './selection-authority.js';

type Candidate = {
  actor_id: string; actor_type: string; routing_enabled: boolean; service_radius_miles: number | null;
  accepted_job_types_json: string[]; excluded_job_types_json: string[]; earliest_available_at: string | null;
  active_capacity: number; avg_rating: number | null; on_time_rate: number | null;
};

type RoutingPolicy = { id:string; version:number; configuration:{ weights?:Record<string,number>; defaults?:Record<string,number>; limits?:Record<string,number>; coordination?:{enabled?:boolean;maxAdjustment?:number;continuityBoost?:number;balanceBoost?:number;spatialBoost?:number;reliabilityBoost?:number;} } };

export async function routeMaintenanceDemand(demandId: string) {
  const demandResult = await pool.query(
    `select d.*, dom.id as domain_id, dom.code as domain_code,
            sc.id as case_id, sc.originating_actor_id, sc.relationship_owner_actor_id, sc.current_owner_actor_id,
            sc.selection_mode, sc.location_id
     from demand_requests d join domains dom on dom.id=d.domain_id
     left join lateral (select * from service_cases where demand_id=d.id order by created_at desc limit 1) sc on true
     where d.id=$1`, [demandId]
  );
  if (!demandResult.rowCount) throw new Error('demand_not_found');
  const demand = demandResult.rows[0];
  if (demand.domain_code !== 'maintenance') throw new Error('unsupported_domain');

  const intelligence = await loadCaseIntelligenceForDemand(demandId);
  const aiCapability = capabilityFromCaseIntelligence(intelligence);
  const requestedCapability = demand.attributes?.requiredCapability ?? aiCapability ?? capabilityForDemand(demand.demand_type,demand.attributes);

  const spatial = demand.case_id
    ? await pool.query('select route_context from case_spatial_context where case_id=$1',[demand.case_id])
    : {rows:[] as any[]};
  const routeCandidates = spatial.rows[0]?.route_context?.candidates ?? {};

  const candidates = await pool.query<Candidate>(
    `select a.id as actor_id,a.actor_type,coalesce(pc.routing_enabled,true) as routing_enabled,
            pc.service_radius_miles,coalesce(pc.accepted_job_types_json,'[]'::jsonb) as accepted_job_types_json,
            coalesce(pc.excluded_job_types_json,'[]'::jsonb) as excluded_job_types_json,pc.earliest_available_at,
            coalesce((select sum(cs.quantity) from capacity_snapshots cs where cs.actor_id=a.id and cs.start_at<=now() and cs.end_at>now()),0)::float as active_capacity,
            (select avg(pm.value) from performance_metrics pm where pm.actor_id=a.id and pm.metric_code='rating')::float as avg_rating,
            (select avg(pm.value) from performance_metrics pm where pm.actor_id=a.id and pm.metric_code='on_time_rate')::float as on_time_rate
     from actors a join actor_capabilities ac on ac.actor_id=a.id and ac.active=true
     join capabilities c on c.id=ac.capability_id left join partner_controls pc on pc.actor_id=a.id
     where a.status='active' and c.capability_code=$1`,[requestedCapability]
  );

  const eligible:any[]=[]; const rejected:any[]=[];
  for (const c of candidates.rows) {
    const accepted=Array.isArray(c.accepted_job_types_json)?c.accepted_job_types_json:[];
    const excluded=Array.isArray(c.excluded_job_types_json)?c.excluded_job_types_json:[];
    if(!c.routing_enabled){rejected.push({actorId:c.actor_id,reason:'routing_disabled'});continue;}
    if(excluded.includes(demand.demand_type)){rejected.push({actorId:c.actor_id,reason:'job_type_excluded'});continue;}
    if(accepted.length&&!accepted.includes(demand.demand_type)){rejected.push({actorId:c.actor_id,reason:'job_type_not_accepted'});continue;}
    if(c.active_capacity<=0&&c.earliest_available_at&&new Date(c.earliest_available_at)>new Date()){rejected.push({actorId:c.actor_id,reason:'no_current_capacity'});continue;}
    const continuity = [demand.originating_actor_id,demand.relationship_owner_actor_id,demand.current_owner_actor_id].filter(Boolean).includes(c.actor_id) ? 1 : 0;
    const route = routeCandidates?.[c.actor_id] ?? {};
    eligible.push({actorId:c.actor_id,signals:{
      capacity:c.active_capacity,rating:c.avg_rating,onTime:c.on_time_rate,
      distanceMiles:finiteOrNull(route.distanceMiles),etaMinutes:finiteOrNull(route.etaMinutes),continuity
    }});
  }

  const policy=await getActivePolicy(demand.domain_id,'maintenance_default');
  if(!policy){
    const decision=await pool.query(`insert into routing_decisions(demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,selected_actor_id,recommended_actor_id,selection_mode,decision_basis) values($1,$2,$3,$4,null,null,$5,$6) returning *`,[demandId,JSON.stringify(eligible.map(x=>x.actorId)),JSON.stringify(rejected),JSON.stringify([]),demand.selection_mode??'customer_choice',`eligible_unranked:${requestedCapability}:policy_missing`]);
    return {decision:decision.rows[0],ranked:[],eligible,rejected,policyRequired:true,engineVersion:COORDINATION_ENGINE_VERSION,intelligence,selectionMode:demand.selection_mode??'customer_choice'};
  }

  const ranked=rankCoordinationCandidates(eligible,policy.configuration,demandId);
  const maxCandidates=positiveInteger(policy.configuration?.limits?.maxCandidates);
  const rankedForDecision=maxCandidates?ranked.slice(0,maxCandidates):ranked;
  const recommended=rankedForDecision[0]?.actorId??null;
  const intelligenceBasis=intelligence.effectiveForAutomation?`:ai:${intelligence.assessmentId}`:':ai:advisory';
  const decision=await pool.query(
    `insert into routing_decisions(demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,selected_actor_id,recommended_actor_id,selection_mode,decision_basis,policy_id,policy_version,rule_version)
     values($1,$2,$3,$4,null,$5,$6,$7,$8,$9,$9) returning *`,
    [demandId,JSON.stringify(eligible.map(x=>x.actorId)),JSON.stringify(rejected),JSON.stringify(rankedForDecision),recommended,demand.selection_mode??'customer_choice',recommended?`coordination_engine:${COORDINATION_ENGINE_VERSION}:${requestedCapability}${intelligenceBasis}`:`no_eligible_actor:${requestedCapability}${intelligenceBasis}`,policy.id,policy.version]
  );
  if(demand.case_id) await recordRecommendation(demand.case_id,recommended,decision.rows[0].id);
  return {decision:decision.rows[0],ranked:rankedForDecision,recommendedActorId:recommended,rejected,policyRequired:false,engineVersion:COORDINATION_ENGINE_VERSION,intelligence,selectionMode:demand.selection_mode??'customer_choice'};
}

async function getActivePolicy(domainId:string,policyKey:string):Promise<RoutingPolicy|null>{const r=await pool.query<RoutingPolicy>(`select id,version,configuration from routing_policies where domain_id=$1 and policy_key=$2 and active=true order by version desc limit 1`,[domainId,policyKey]);return r.rows[0]??null;}
function capabilityForDemand(demandType:string,attributes:any):string{if(attributes?.drivability==='non_drivable')return'tow';if(demandType.includes('diagnostic')||attributes?.requiresDiagnostic===true)return'diagnostics';if(demandType.includes('tow'))return'tow';if(demandType.includes('part'))return'parts_supply';return'repair';}
function positiveInteger(value:unknown){return typeof value==='number'&&Number.isInteger(value)&&value>0?value:null;}
function finiteOrNull(value:unknown){return typeof value==='number'&&Number.isFinite(value)?value:null;}
