import type { PoolClient } from 'pg';
import {
  CAPACITY_CURRENT_MAX_AGE_MS,
  CAPACITY_STALE_MAX_AGE_MS,
  type CapacityConfidence,
  type CapacityState,
  type PartnerOperatingMode,
  type SyncState
} from './liveCapacity.js';
import { syncOperationalConstraints } from './case-constraint-projection.js';
import { evaluateServiceability, type ServiceabilityConstraint, type ServiceabilityDecision } from './serviceability.js';

type Queryable = Pick<PoolClient, 'query'>;

export type ServiceabilityIntent = 'route' | 'hold' | 'confirm';

export type ActorServiceability = {
  decision: ServiceabilityDecision;
  source: 'canonical_capacity' | 'legacy_capacity' | 'missing';
  capacityWindowId: string | null;
  capacityUnits: number;
};

export type CanonicalWindowRow = {
  id:string;
  capacity_state:CapacityState;
  confidence:CapacityConfidence;
  sync_state:SyncState;
  capacity_units:number|string;
  updated_at:string|Date;
  source_connection_id:string|null;
  connection_mode:PartnerOperatingMode|null;
  connection_status:string|null;
  connection_last_success_at:string|Date|null;
  service_category:string|null;
  scope_rank?:number|string;
};

export async function evaluateActorServiceability(
  caseId: string | null | undefined,
  actorId: string,
  serviceCategory: string | null | undefined,
  intent: ServiceabilityIntent,
  queryable?: Queryable,
  now = new Date()
): Promise<ActorServiceability> {
  const db = queryable ?? (await import('../db/pool.js')).pool;
  const actor = await db.query(
    `select a.organization_id,a.location_id,
            exists(
              select 1 from partner_system_connections psc
              where (
                (a.location_id is not null and psc.location_id=a.location_id)
                or (a.organization_id is not null and psc.organization_id=a.organization_id and psc.location_id is null)
              )
            ) as has_connection_model
     from actors a where a.id=$1`,
    [actorId]
  );

  if (!actor.rowCount) {
    return { decision:evaluateServiceability({capacity:null,requirementsProjected:false}), source:'missing', capacityWindowId:null, capacityUnits:0 };
  }

  const a = actor.rows[0];
  if(caseId) await syncOperationalConstraints(caseId,db);
  const constraints = caseId ? await loadConstraints(caseId,db) : [];
  const requirementsProjected=Boolean(caseId && serviceCategory);
  const canonical = await db.query<CanonicalWindowRow>(
    `select cw.id,cw.capacity_state,cw.confidence,cw.sync_state,
            greatest(cw.capacity_units-coalesce((
              select sum(cr.units)
                from capacity_reservations cr
               where cr.capacity_window_id=cw.id
                 and cr.state='held'
                 and cr.expires_at>now()
                 and ($4::uuid is null or cr.service_case_id<>$4)
            ),0),0)::int as capacity_units,
            cw.updated_at,cw.source_connection_id,cw.service_category,
            psc.mode as connection_mode,psc.connection_status,psc.last_success_at as connection_last_success_at,
            case when $1::uuid is not null and cw.location_id=$1 then 0 else 1 end as scope_rank
       from capacity_windows cw
       left join partner_system_connections psc on psc.id=cw.source_connection_id
      where cw.window_start<=now() and cw.window_end>now()
        and (
          ($1::uuid is not null and cw.location_id=$1)
          or ($2::uuid is not null and cw.organization_id=$2 and cw.location_id is null)
        )
        and ($3::text is null or cw.service_category is null or cw.service_category=$3)
      order by scope_rank asc,(cw.service_category=$3) desc nulls last,cw.updated_at desc,cw.capacity_units desc`,
    [a.location_id ?? null,a.organization_id ?? null,serviceCategory ?? null,caseId ?? null]
  );

  const canonicalEvaluation=evaluateCanonicalWindows(canonical.rows,constraints,intent,serviceCategory ?? null,now,requirementsProjected);
  if(canonicalEvaluation) return canonicalEvaluation;

  if (!a.has_connection_model) {
    const legacy=await db.query(
      `select coalesce(sum(quantity),0)::float as units
       from capacity_snapshots where actor_id=$1 and start_at<=now() and end_at>now()`,
      [actorId]
    );
    const units=Number(legacy.rows[0]?.units ?? 0);
    const decision=evaluateServiceability({
      capacity:{capacityState:units>0?'available':'full',confidence:'declared',syncState:'current',capacityUnits:units},
      constraints,
      requirementsProjected,
      allowManualVerified:false,
      allowStaleHold:intent==='hold'
    });
    return {decision,source:'legacy_capacity',capacityWindowId:null,capacityUnits:units};
  }

  return { decision:evaluateServiceability({capacity:null,constraints,requirementsProjected}), source:'missing', capacityWindowId:null, capacityUnits:0 };
}

export function evaluateCanonicalWindows(
  rows:CanonicalWindowRow[],
  constraints:ServiceabilityConstraint[],
  intent:ServiceabilityIntent,
  serviceCategory:string|null=null,
  now=new Date(),
  requirementsProjected=true
):ActorServiceability|null {
  let firstRejected:ActorServiceability|null=null;
  let sawRelevant=false;

  for(const row of rows){
    if(serviceCategory && row.service_category && row.service_category!==serviceCategory) continue;
    sawRelevant=true;
    const syncState=deriveCanonicalSyncState(row,now);
    const confidence=deriveEffectiveConfidence(row.confidence,syncState);
    const capacityUnits=Number(row.capacity_units);
    const decision=evaluateServiceability({
      capacity:{
        capacityState:row.capacity_state,
        confidence,
        syncState,
        capacityUnits:Number.isFinite(capacityUnits)?capacityUnits:0
      },
      constraints,
      requirementsProjected,
      allowManualVerified:false,
      allowStaleHold:intent==='hold'
    });
    const result:ActorServiceability={
      decision,
      source:'canonical_capacity',
      capacityWindowId:row.id,
      capacityUnits:Number.isFinite(capacityUnits)?capacityUnits:0
    };
    if(serviceabilityAllows(intent,decision)) return result;
    if(!firstRejected) firstRejected=result;
  }
  return sawRelevant?firstRejected:null;
}

export function deriveCanonicalSyncState(row:CanonicalWindowRow,now=new Date()):SyncState {
  if(row.connection_status==='failed'||row.connection_status==='revoked') return 'failed';
  if(row.connection_status==='degraded'||row.connection_status==='paused'||row.connection_status==='planned') return 'degraded';

  if(row.connection_mode==='roviq_native') {
    return row.sync_state==='failed'?'failed':row.sync_state==='manual'?'manual':'current';
  }

  const anchor=row.connection_mode==='native_integration'
    ? row.connection_last_success_at
    : row.connection_mode==='bridge'
      ? row.updated_at
      : row.source_connection_id
        ? row.connection_last_success_at
        : row.updated_at;

  if(!anchor) return 'degraded';
  const anchorMs=new Date(anchor).getTime();
  if(!Number.isFinite(anchorMs)) return 'degraded';
  const ageMs=Math.max(0,now.getTime()-anchorMs);
  if(ageMs<=CAPACITY_CURRENT_MAX_AGE_MS) return row.sync_state==='manual'?'manual':'current';
  if(ageMs<=CAPACITY_STALE_MAX_AGE_MS) return 'stale';
  return 'degraded';
}

export function serviceabilityAllows(intent:ServiceabilityIntent, decision:ServiceabilityDecision) {
  if (intent==='route') return decision.eligible;
  if (intent==='hold') return decision.holdable;
  return decision.confirmable;
}

function deriveEffectiveConfidence(stored:CapacityConfidence,syncState:SyncState):CapacityConfidence {
  if(syncState==='failed'||syncState==='degraded') return 'unknown';
  if(syncState==='stale') return 'stale';
  return stored;
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
