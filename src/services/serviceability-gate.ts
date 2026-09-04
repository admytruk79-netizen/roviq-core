import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { evaluateServiceability, type ServiceabilityConstraint, type ServiceabilityDecision } from './serviceability.js';

type Queryable = Pick<PoolClient, 'query'>;

export type ServiceabilityIntent = 'route' | 'hold' | 'confirm';

export type ActorServiceability = {
  decision: ServiceabilityDecision;
  source: 'canonical_capacity' | 'legacy_capacity' | 'missing';
  capacityWindowId: string | null;
};

export async function evaluateActorServiceability(
  caseId: string | null | undefined,
  actorId: string,
  serviceCategory: string | null | undefined,
  intent: ServiceabilityIntent,
  queryable: Queryable = pool
): Promise<ActorServiceability> {
  const actor = await queryable.query(
    `select a.organization_id,a.location_id,
            exists(
              select 1 from partner_system_connections psc
              where (psc.location_id=a.location_id or (a.location_id is null and psc.organization_id=a.organization_id))
                and psc.connection_status in ('active','degraded','failed')
            ) as has_connection
     from actors a where a.id=$1`,
    [actorId]
  );

  if (!actor.rowCount) {
    return { decision:evaluateServiceability({capacity:null}), source:'missing', capacityWindowId:null };
  }

  const a = actor.rows[0];
  const constraints = caseId ? await loadConstraints(caseId,queryable) : [];
  const canonical = await queryable.query(
    `select id,capacity_state,confidence,sync_state,capacity_units
     from capacity_windows
     where window_start<=now() and window_end>now()
       and (
         ($1::uuid is not null and location_id=$1)
         or ($1::uuid is null and $2::uuid is not null and organization_id=$2)
       )
       and ($3::text is null or service_category is null or service_category=$3)
     order by (service_category=$3) desc nulls last, capacity_units desc, updated_at desc
     limit 1`,
    [a.location_id ?? null,a.organization_id ?? null,serviceCategory ?? null]
  );

  let source: ActorServiceability['source']='missing';
  let capacityWindowId:string|null=null;
  let capacity:any=null;

  if (canonical.rowCount) {
    const row=canonical.rows[0];
    source='canonical_capacity';
    capacityWindowId=row.id;
    capacity={
      capacityState:row.capacity_state,
      confidence:row.confidence,
      syncState:row.sync_state,
      capacityUnits:Number(row.capacity_units)
    };
  } else if (!a.has_connection) {
    // Transitional compatibility for actors not yet onboarded to ROVIQ Connect/Shop OS.
    // Once a partner connection exists, canonical capacity becomes mandatory and missing
    // windows fail closed rather than silently falling back to legacy snapshots.
    const legacy=await queryable.query(
      `select coalesce(sum(quantity),0)::float as units
       from capacity_snapshots where actor_id=$1 and start_at<=now() and end_at>now()`,
      [actorId]
    );
    source='legacy_capacity';
    const units=Number(legacy.rows[0]?.units ?? 0);
    capacity={
      capacityState:units>0?'available':'full',
      confidence:'declared',
      syncState:'current',
      capacityUnits:units
    };
  }

  const decision=evaluateServiceability({
    capacity,
    constraints,
    allowManualVerified:false,
    allowStaleHold:intent==='hold'
  });

  return {decision,source,capacityWindowId};
}

export function serviceabilityAllows(intent:ServiceabilityIntent, decision:ServiceabilityDecision) {
  if (intent==='route') return decision.eligible;
  if (intent==='hold') return decision.holdable;
  return decision.confirmable;
}

async function loadConstraints(caseId:string,queryable:Queryable):Promise<ServiceabilityConstraint[]> {
  const r=await queryable.query(
    `select constraint_type,status,details from case_constraints where service_case_id=$1`,
    [caseId]
  );
  return r.rows.map((row:any)=>({
    type:row.constraint_type,
    status:row.status,
    required:true,
    details:row.details ?? {}
  }));
}
