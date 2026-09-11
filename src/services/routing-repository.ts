import { pool } from '../db/pool.js';

export type RoutingCandidateRow = {
  actor_id: string;
  actor_type: string;
  routing_enabled: boolean;
  service_radius_miles: number | null;
  accepted_job_types_json: string[];
  excluded_job_types_json: string[];
  earliest_available_at: string | null;
  active_capacity: number;
  avg_rating: number | null;
  on_time_rate: number | null;
};

export type RoutingPolicyRecord = {
  id:string;
  version:number;
  configuration:{
    weights?:Record<string,number>;
    defaults?:Record<string,number>;
    limits?:Record<string,number>;
    coordination?:{
      enabled?:boolean;
      maxAdjustment?:number;
      continuityBoost?:number;
      balanceBoost?:number;
      spatialBoost?:number;
      reliabilityBoost?:number;
    };
  };
};

export async function loadRoutingDemand(demandId:string){
  const result=await pool.query(
    `select d.*, dom.id as domain_id, dom.code as domain_code,
            sc.id as case_id, sc.originating_actor_id, sc.relationship_owner_actor_id, sc.current_owner_actor_id,
            sc.selection_mode, sc.location_id
       from demand_requests d
       join domains dom on dom.id=d.domain_id
       left join lateral (
         select * from service_cases where demand_id=d.id order by created_at desc limit 1
       ) sc on true
      where d.id=$1`,
    [demandId]
  );
  return result.rows[0] ?? null;
}

export async function loadRouteCandidates(caseId:string|null|undefined){
  if(!caseId) return {} as Record<string,Record<string,unknown>>;
  const result=await pool.query('select route_context from case_spatial_context where case_id=$1',[caseId]);
  return result.rows[0]?.route_context?.candidates ?? {};
}

export async function loadRoutingCandidates(requiredCapability:string){
  const result=await pool.query<RoutingCandidateRow>(
    `select a.id as actor_id,a.actor_type,coalesce(pc.routing_enabled,true) as routing_enabled,
            pc.service_radius_miles,coalesce(pc.accepted_job_types_json,'[]'::jsonb) as accepted_job_types_json,
            coalesce(pc.excluded_job_types_json,'[]'::jsonb) as excluded_job_types_json,pc.earliest_available_at,
            coalesce((select sum(cs.quantity) from capacity_snapshots cs where cs.actor_id=a.id and cs.start_at<=now() and cs.end_at>now()),0)::float as active_capacity,
            (select avg(pm.value) from performance_metrics pm where pm.actor_id=a.id and pm.metric_code='rating')::float as avg_rating,
            (select avg(pm.value) from performance_metrics pm where pm.actor_id=a.id and pm.metric_code='on_time_rate')::float as on_time_rate
       from actors a
       join actor_capabilities ac on ac.actor_id=a.id and ac.active=true
       join capabilities c on c.id=ac.capability_id
       left join partner_controls pc on pc.actor_id=a.id
      where a.status='active' and c.capability_code=$1`,
    [requiredCapability]
  );
  return result.rows;
}

export async function loadActiveRoutingPolicy(domainId:string,policyKey:string):Promise<RoutingPolicyRecord|null>{
  const result=await pool.query<RoutingPolicyRecord>(
    `select id,version,configuration
       from routing_policies
      where domain_id=$1 and policy_key=$2 and active=true
      order by version desc
      limit 1`,
    [domainId,policyKey]
  );
  return result.rows[0] ?? null;
}

export async function persistRoutingDecision(input:{
  demandId:string;
  eligibleActorIds:string[];
  rejectedCandidates:unknown[];
  rankingTrace:unknown[];
  recommendedActorId:string|null;
  selectionMode:string;
  decisionBasis:string;
  policy?:RoutingPolicyRecord|null;
}){
  if(!input.policy){
    const result=await pool.query(
      `insert into routing_decisions(
        demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,
        selected_actor_id,recommended_actor_id,selection_mode,decision_basis
      ) values($1,$2,$3,$4,null,null,$5,$6) returning *`,
      [
        input.demandId,
        JSON.stringify(input.eligibleActorIds),
        JSON.stringify(input.rejectedCandidates),
        JSON.stringify(input.rankingTrace),
        input.selectionMode,
        input.decisionBasis
      ]
    );
    return result.rows[0];
  }

  const result=await pool.query(
    `insert into routing_decisions(
      demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,
      selected_actor_id,recommended_actor_id,selection_mode,decision_basis,
      policy_id,policy_version,rule_version
    ) values($1,$2,$3,$4,null,$5,$6,$7,$8,$9,$9) returning *`,
    [
      input.demandId,
      JSON.stringify(input.eligibleActorIds),
      JSON.stringify(input.rejectedCandidates),
      JSON.stringify(input.rankingTrace),
      input.recommendedActorId,
      input.selectionMode,
      input.decisionBasis,
      input.policy.id,
      input.policy.version
    ]
  );
  return result.rows[0];
}
