import { pool } from '../db/pool.js';

type Candidate = {
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

export async function routeMaintenanceDemand(demandId: string) {
  const demandResult = await pool.query(
    `select d.*, dom.code as domain_code from demand_requests d
     join domains dom on dom.id=d.domain_id where d.id=$1`, [demandId]
  );
  if (!demandResult.rowCount) throw new Error('demand_not_found');
  const demand = demandResult.rows[0];
  if (demand.domain_code !== 'maintenance') throw new Error('unsupported_domain');

  const requestedCapability = demand.attributes?.requiredCapability ?? capabilityForDemand(demand.demand_type, demand.attributes);
  const candidates = await pool.query<Candidate>(
    `select a.id as actor_id, a.actor_type,
            coalesce(pc.routing_enabled,true) as routing_enabled,
            pc.service_radius_miles, coalesce(pc.accepted_job_types_json,'[]'::jsonb) as accepted_job_types_json,
            coalesce(pc.excluded_job_types_json,'[]'::jsonb) as excluded_job_types_json,
            pc.earliest_available_at,
            coalesce((select sum(cs.quantity) from capacity_snapshots cs
              where cs.actor_id=a.id and cs.start_at <= now() and cs.end_at > now()),0)::float as active_capacity,
            (select avg(pm.value) from performance_metrics pm where pm.actor_id=a.id and pm.metric_code='rating')::float as avg_rating,
            (select avg(pm.value) from performance_metrics pm where pm.actor_id=a.id and pm.metric_code='on_time_rate')::float as on_time_rate
     from actors a
     join actor_capabilities ac on ac.actor_id=a.id and ac.active=true
     join capabilities c on c.id=ac.capability_id
     left join partner_controls pc on pc.actor_id=a.id
     where a.status='active' and c.capability_code=$1`, [requestedCapability]
  );

  const eligible: any[] = [];
  const rejected: any[] = [];
  for (const c of candidates.rows) {
    const accepted = Array.isArray(c.accepted_job_types_json) ? c.accepted_job_types_json : [];
    const excluded = Array.isArray(c.excluded_job_types_json) ? c.excluded_job_types_json : [];
    if (!c.routing_enabled) { rejected.push({ actorId:c.actor_id, reason:'routing_disabled' }); continue; }
    if (excluded.includes(demand.demand_type)) { rejected.push({ actorId:c.actor_id, reason:'job_type_excluded' }); continue; }
    if (accepted.length && !accepted.includes(demand.demand_type)) { rejected.push({ actorId:c.actor_id, reason:'job_type_not_accepted' }); continue; }
    if (c.active_capacity <= 0 && c.earliest_available_at && new Date(c.earliest_available_at) > new Date()) {
      rejected.push({ actorId:c.actor_id, reason:'no_current_capacity' }); continue;
    }
    const score = scoreCandidate(c);
    eligible.push({ actorId:c.actor_id, score, basis:{ capacity:c.active_capacity, rating:c.avg_rating, onTime:c.on_time_rate } });
  }
  eligible.sort((a,b) => b.score-a.score);
  eligible.forEach((x,i) => x.rank=i+1);

  const selected = eligible[0]?.actorId ?? null;
  const decision = await pool.query(
    `insert into routing_decisions(demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,selected_actor_id,decision_basis)
     values($1,$2,$3,$4,$5,$6) returning *`,
    [demandId, JSON.stringify(eligible.map(x=>x.actorId)), JSON.stringify(rejected), JSON.stringify(eligible), selected,
      selected ? `ranked_filter:${requestedCapability}` : `no_eligible_actor:${requestedCapability}`]
  );
  return { decision: decision.rows[0], ranked: eligible, rejected };
}

function capabilityForDemand(demandType: string, attributes: any): string {
  if (attributes?.drivability === 'non_drivable') return 'tow';
  if (demandType.includes('diagnostic') || attributes?.requiresDiagnostic === true) return 'diagnostics';
  if (demandType.includes('tow')) return 'tow';
  if (demandType.includes('part')) return 'parts_supply';
  return 'repair';
}

function scoreCandidate(c: Candidate) {
  const capacity = Math.min(Math.max(c.active_capacity,0),10) * 10;
  const rating = (c.avg_rating ?? 3) * 10;
  const onTime = (c.on_time_rate ?? 0.8) * 30;
  return Math.round((capacity + rating + onTime) * 100) / 100;
}
