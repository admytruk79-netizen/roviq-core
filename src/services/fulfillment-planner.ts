import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { routeMaintenanceDemand } from './routing.js';
import { syncOperationalConstraints } from './case-constraint-projection.js';
import { appendCaseEvent } from './case-events.js';
import { audit } from './audit.js';

type Queryable = { query:(text:string,params?:unknown[])=>Promise<any> };

export function constraintBlockers(rows:any[]){
  return rows
    .filter((row)=>!['satisfied','waived'].includes(String(row.status)))
    .map((row)=>({
      type:String(row.constraint_type),
      status:String(row.status),
      projectionKey:row.projection_key??null,
      details:row.details??{}
    }));
}

export function fulfillmentPlanStatus(candidateCount:number,blockers:unknown[]){
  return candidateCount>0&&blockers.length===0?'feasible' as const:'blocked' as const;
}

async function loadDependencySnapshot(caseId:string,db:Queryable){
  const [constraints,parts,mobility,transport,authorization]=await Promise.all([
    db.query(`select constraint_type,status,projection_key,details from case_constraints where service_case_id=$1 order by constraint_type,projection_key nulls last`,[caseId]),
    db.query(`select readiness_status,count(*)::int as count from case_parts_requirements where service_case_id=$1 and readiness_status<>'cancelled' group by readiness_status`,[caseId]),
    db.query(`select id,state,provider_actor_id,resource_id,created_at from mobility_allocations where case_id=$1 and state<>'cancelled' order by created_at desc,id desc limit 1`,[caseId]),
    db.query(`select id,status,provider_actor_id,dropoff_location,eta_at,dispatch_sequence from transport_dispatches where case_id=$1 and status<>'cancelled' order by dispatch_sequence desc limit 1`,[caseId]),
    db.query(`select id,warranty_coverage_id,constraint_type,status,details,source from repair_authorization_constraints where service_case_id=$1 order by created_at,id`,[caseId])
  ]);
  return {
    constraints:constraints.rows,
    parts:Object.fromEntries(parts.rows.map((row:any)=>[String(row.readiness_status),Number(row.count)])),
    mobility:mobility.rows[0]??null,
    transport:transport.rows[0]??null,
    repairAuthorization:authorization.rows
  };
}

export async function generateFulfillmentPlan(principal:Principal,caseId:string){
  const initial=await pool.query(
    `select id,demand_id,vehicle_id,state from service_cases where id=$1`,
    [caseId]
  );
  if(!initial.rowCount) throw Object.assign(new Error('case_not_found'),{statusCode:404});
  const serviceCase=initial.rows[0];
  if(!serviceCase.demand_id) throw Object.assign(new Error('case_demand_required'),{statusCode:409});

  // Refresh canonical projections and run the existing routing/serviceability
  // authority before opening the persistence transaction. routeMaintenanceDemand
  // may itself persist a routing decision/recommendation, so holding the case row
  // here would create a cross-connection lock cycle.
  await syncOperationalConstraints(caseId,pool);
  const snapshot=await loadDependencySnapshot(caseId,pool);
  const blockers=constraintBlockers(snapshot.constraints);
  const routing=await routeMaintenanceDemand(serviceCase.demand_id);
  const ranked=Array.isArray(routing.ranked)?routing.ranked:[];
  const status=fulfillmentPlanStatus(ranked.length,blockers);

  const client=await pool.connect();
  let plan:any;
  const candidates:any[]=[];
  try{
    await client.query('begin');
    const current=await client.query(
      `select id,demand_id from service_cases where id=$1 for update`,
      [caseId]
    );
    if(!current.rowCount) throw Object.assign(new Error('case_not_found'),{statusCode:404});
    if(current.rows[0].demand_id!==serviceCase.demand_id) throw Object.assign(new Error('case_demand_changed'),{statusCode:409});

    const versionResult=await client.query(
      `select coalesce(max(version),0)+1 as next_version from fulfillment_plans where service_case_id=$1`,
      [caseId]
    );
    const version=Number(versionResult.rows[0]?.next_version??1);

    await client.query(
      `update fulfillment_plans set status='superseded',updated_at=now()
        where service_case_id=$1 and status in ('draft','feasible','blocked')`,
      [caseId]
    );

    const inserted=await client.query(
      `insert into fulfillment_plans(
        service_case_id,version,status,routing_decision_id,selected_actor_id,blockers,dependency_snapshot,created_by_actor_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        caseId,version,status,routing.decision?.id??null,routing.recommendedActorId??null,
        JSON.stringify(blockers),JSON.stringify(snapshot),principal.actorId??null
      ]
    );
    plan=inserted.rows[0];

    for(let i=0;i<ranked.length;i++){
      const candidate=ranked[i] as any;
      const row=await client.query(
        `insert into fulfillment_candidates(
          fulfillment_plan_id,actor_id,rank,score,serviceability,signals
         ) values($1,$2,$3,$4,$5,$6) returning *`,
        [
          plan.id,candidate.actorId,i+1,candidate.score??null,
          JSON.stringify(candidate.serviceability??{}),
          JSON.stringify(candidate.signals??{})
        ]
      );
      candidates.push(row.rows[0]);
    }

    await client.query('commit');
  }catch(error){
    await client.query('rollback').catch(()=>{});
    throw error;
  }finally{
    client.release();
  }

  await appendCaseEvent(caseId,'FULFILLMENT_PLAN_GENERATED',principal,{
    fulfillmentPlanId:plan.id,
    version:plan.version,
    status:plan.status,
    candidateCount:candidates.length,
    blockerCount:blockers.length
  });
  await audit(principal,'generate_fulfillment_plan','fulfillment_plan',plan.id,'network_fulfillment_plan_generated',{
    caseId,version:plan.version,status:plan.status,candidateCount:candidates.length,blockerCount:blockers.length
  });
  return {plan,candidates};
}

export async function getLatestFulfillmentPlan(caseId:string){
  const planResult=await pool.query(
    `select * from fulfillment_plans where service_case_id=$1 order by version desc limit 1`,
    [caseId]
  );
  const plan=planResult.rows[0]??null;
  if(!plan) return null;
  const candidates=await pool.query(
    `select * from fulfillment_candidates where fulfillment_plan_id=$1 order by rank asc`,
    [plan.id]
  );
  return {plan,candidates:candidates.rows};
}
