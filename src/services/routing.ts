import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { COORDINATION_ENGINE_VERSION, rankCoordinationCandidates } from './coordination-engine.js';
import { resolveRequestedCapabilityForDemand } from './case-intelligence.js';
import { autoDispatchCase, recordRecommendation } from './selection-authority.js';
import { evaluateActorServiceability, serviceabilityAllows, type ServiceabilityIntent } from './serviceability-gate.js';
import { raiseException, transitionCase } from './orchestration.js';
import { audit } from './audit.js';
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
      selectionMode,
      requestedCapability
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
    selectionMode,
    requestedCapability
  };
}

/**
 * Automatic dispatch: the platform's core value proposition is that ROVIQ owns the routing
 * intelligence, not that an admin manually triggers it per request. Called right after a new
 * maintenance demand/case is created; failures are logged, not thrown, so a routing problem never
 * blocks intake itself -- a case simply stays at 'triage' and can still be routed manually via
 * POST /api/admin/demands/:id/route (which also fails closed the same way when no policy exists).
 *
 * Runs as the system, not as whichever principal happened to submit the demand (often a
 * customer): the triage->diagnostic_pending/provider_selection transition is admin-gated by
 * case_transition_rules, matching every other automatic, non-human-initiated transition in the
 * codebase (e.g. the webhook gateway's principal:{role:'admin'}).
 */
export async function autoRouteNewDemand(triggeredBy: Principal, demandId: string) {
  const systemPrincipal: Principal = { role: 'admin' };
  try {
    const result = await routeMaintenanceDemand(demandId);
    const caseResult = await pool.query('select * from service_cases where demand_id=$1 order by created_at desc limit 1', [demandId]);
    let serviceCase = caseResult.rows[0] ?? null;
    if (!serviceCase) return null;
    const recommended = result.recommendedActorId ?? null;

    // Matches the fail-closed convention already used for auto-dispatch elsewhere in this engine:
    // without an active routing policy for the domain, there's nothing configured to route
    // against, so the case is left at 'triage' for manual handling exactly as before -- the same
    // one-time setup (configuring a policy) that auto-dispatch already requires, not a new one.
    if (serviceCase.state === 'triage' && !result.policyRequired) {
      serviceCase = await transitionCase(systemPrincipal, serviceCase.id, result.requestedCapability === 'diagnostics' ? 'diagnostic_pending' : 'provider_selection', { source: 'auto_routing', triggeredByRole: triggeredBy.role });
    }

    // Offer auto-creation is intentionally gated on auto_dispatch, matching the manual admin
    // endpoint: for customer_choice (the default), the ranked/eligible list is now computed and
    // stored so the customer/an admin can act on it, but no single actor is unilaterally offered
    // the job -- that would defeat "the customer, not an algorithm, picks the shop."
    let offer: unknown = null;
    if (serviceCase && recommended && serviceCase.selection_mode === 'auto_dispatch') {
      try {
        await autoDispatchCase(serviceCase.id, recommended, result.decision?.id ?? null, { source: 'auto_routing' });
        const first = result.ranked[0] as { score?: number } | undefined;
        const r = await pool.query(
          `insert into matches_offers(demand_id,case_id,actor_id,score,rank,rule_basis) values($1,$2,$3,$4,1,$5) returning *`,
          [demandId, serviceCase.id, recommended, first?.score ?? null, 'coordination_recommendation_v2']
        );
        offer = r.rows[0];
        const refreshed = await pool.query('select * from service_cases where id=$1', [serviceCase.id]);
        serviceCase = refreshed.rows[0] ?? serviceCase;
      } catch (error) {
        if (error instanceof Error && (error.message === 'actor_not_serviceable' || error.message === 'case_not_selectable')) {
          await raiseException(serviceCase.id, 'PROVIDER_CAPACITY_CHANGED', 'Recommended provider capacity changed before auto-dispatch could commit.', 'warning', { demandId, recommendedActorId: recommended });
          const refreshed = await pool.query('select * from service_cases where id=$1', [serviceCase.id]);
          serviceCase = refreshed.rows[0] ?? serviceCase;
        } else {
          throw error;
        }
      }
    } else if (serviceCase && !recommended) {
      await raiseException(serviceCase.id, 'NO_ELIGIBLE_PROVIDER', 'No eligible provider found for the current service requirements.', 'warning', { demandId });
    }

    await audit(triggeredBy, 'auto_route_demand', 'demand_request', demandId, 'coordination_recommendation_v2', {
      caseId: serviceCase?.id ?? null,
      recommendedActorId: recommended,
      selectionMode: serviceCase?.selection_mode ?? null,
      eligibleCount: result.ranked.length,
      rejectedCount: result.rejected.length
    });

    return { case: serviceCase, offer, result };
  } catch (error) {
    console.error('auto_route_demand_failed', { demandId, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function positiveInteger(value:unknown){
  return typeof value==='number'&&Number.isInteger(value)&&value>0?value:null;
}

function finiteOrNull(value:unknown){
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}
