import { COORDINATION_ENGINE_VERSION, rankCoordinationCandidates } from './coordination-engine.js';
import { resolveRequestedCapabilityForDemand } from './case-intelligence.js';
import { recordRecommendation } from './selection-authority.js';
import { evaluateActorServiceability, serviceabilityAllows, type ServiceabilityIntent } from './serviceability-gate.js';
import {
  loadActiveRoutingPolicy,
  loadRouteCandidates,
  loadRoutingCandidates,
  loadRoutingDemand,
  persistRoutingDecision
} from './routing-repository.js';

export function routingIntentForSelectionMode(selectionMode:string|null|undefined):ServiceabilityIntent{
  return selectionMode==='auto_dispatch'?'confirm':'route';
}

export async function routeMaintenanceDemand(demandId: string) {
  const demand=await loadRoutingDemand(demandId);
  if(!demand) throw new Error('demand_not_found');
  if(demand.domain_code!=='maintenance') throw new Error('unsupported_domain');

  const { capability:requestedCapability, intelligence }=await resolveRequestedCapabilityForDemand(demandId);
  const routingIntent=routingIntentForSelectionMode(demand.selection_mode);
  const routeCandidates=await loadRouteCandidates(demand.case_id);
  const candidates=await loadRoutingCandidates(requestedCapability);

  const eligible:any[]=[];
  const rejected:any[]=[];

  for(const candidate of candidates){
    const accepted=Array.isArray(candidate.accepted_job_types_json)?candidate.accepted_job_types_json:[];
    const excluded=Array.isArray(candidate.excluded_job_types_json)?candidate.excluded_job_types_json:[];

    if(!candidate.routing_enabled){
      rejected.push({actorId:candidate.actor_id,reason:'routing_disabled'});
      continue;
    }
    if(excluded.includes(demand.demand_type)){
      rejected.push({actorId:candidate.actor_id,reason:'job_type_excluded'});
      continue;
    }
    if(accepted.length&&!accepted.includes(demand.demand_type)){
      rejected.push({actorId:candidate.actor_id,reason:'job_type_not_accepted'});
      continue;
    }

    const serviceability=await evaluateActorServiceability(
      demand.case_id,
      candidate.actor_id,
      requestedCapability,
      routingIntent
    );
    if(!serviceabilityAllows(routingIntent,serviceability.decision)){
      rejected.push({
        actorId:candidate.actor_id,
        reason:routingIntent==='confirm'?'not_confirmable_for_auto_dispatch':'serviceability_blocked',
        serviceabilityReasons:serviceability.decision.reasons,
        capacitySource:serviceability.source
      });
      continue;
    }

    if(
      serviceability.source==='legacy_capacity'&&
      serviceability.capacityUnits<=0&&
      candidate.earliest_available_at&&
      new Date(candidate.earliest_available_at)>new Date()
    ){
      rejected.push({actorId:candidate.actor_id,reason:'no_current_capacity'});
      continue;
    }

    const continuity=[
      demand.originating_actor_id,
      demand.relationship_owner_actor_id,
      demand.current_owner_actor_id
    ].filter(Boolean).includes(candidate.actor_id)?1:0;
    const route=routeCandidates?.[candidate.actor_id] ?? {};

    eligible.push({
      actorId:candidate.actor_id,
      signals:{
        capacity:serviceability.capacityUnits,
        rating:candidate.avg_rating,
        onTime:candidate.on_time_rate,
        distanceMiles:finiteOrNull(route.distanceMiles),
        etaMinutes:finiteOrNull(route.etaMinutes),
        continuity
      },
      serviceability:{
        capacitySource:serviceability.source,
        capacityWindowId:serviceability.capacityWindowId,
        capacityUnits:serviceability.capacityUnits,
        reasons:serviceability.decision.reasons
      }
    });
  }

  const selectionMode=demand.selection_mode??'customer_choice';
  const policy=await loadActiveRoutingPolicy(demand.domain_id,'maintenance_default');

  if(!policy){
    const decision=await persistRoutingDecision({
      demandId,
      eligibleActorIds:eligible.map(candidate=>candidate.actorId),
      rejectedCandidates:rejected,
      rankingTrace:[],
      recommendedActorId:null,
      selectionMode,
      decisionBasis:`eligible_unranked:${requestedCapability}:policy_missing`
    });
    return {
      decision,
      ranked:[],
      eligible,
      rejected,
      policyRequired:true,
      engineVersion:COORDINATION_ENGINE_VERSION,
      intelligence,
      selectionMode
    };
  }

  const ranked=rankCoordinationCandidates(eligible,policy.configuration,demandId);
  const maxCandidates=positiveInteger(policy.configuration?.limits?.maxCandidates);
  const rankedForDecision=maxCandidates?ranked.slice(0,maxCandidates):ranked;
  const recommended=rankedForDecision[0]?.actorId??null;
  const intelligenceBasis=intelligence.effectiveForAutomation?`:ai:${intelligence.assessmentId}`:':ai:advisory';
  const decisionBasis=recommended
    ?`coordination_engine:${COORDINATION_ENGINE_VERSION}:${requestedCapability}:serviceability_gated${intelligenceBasis}`
    :`no_eligible_actor:${requestedCapability}:serviceability_gated${intelligenceBasis}`;

  const decision=await persistRoutingDecision({
    demandId,
    eligibleActorIds:eligible.map(candidate=>candidate.actorId),
    rejectedCandidates:rejected,
    rankingTrace:rankedForDecision,
    recommendedActorId:recommended,
    selectionMode,
    decisionBasis,
    policy
  });

  if(demand.case_id) await recordRecommendation(demand.case_id,recommended,decision.id);

  return {
    decision,
    ranked:rankedForDecision,
    recommendedActorId:recommended,
    rejected,
    policyRequired:false,
    engineVersion:COORDINATION_ENGINE_VERSION,
    intelligence,
    selectionMode
  };
}

function positiveInteger(value:unknown){
  return typeof value==='number'&&Number.isInteger(value)&&value>0?value:null;
}

function finiteOrNull(value:unknown){
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}
