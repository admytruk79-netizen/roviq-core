import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';
import { getAdminActorScope } from './admin-case-scope.js';
import { getPilotReadiness } from './pilot-readiness.js';

function httpError(message:string,statusCode:number){
  return Object.assign(new Error(message),{statusCode});
}

async function assertScope(principal:Principal,organizationId:string,locationId:string){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const scope=await getAdminActorScope(principal,pool);
  if(!scope) return;
  if(scope.organizationId!==organizationId) throw httpError('forbidden',403);
  if(scope.locationId&&scope.locationId!==locationId) throw httpError('forbidden',403);
}

export async function createPilotRun(principal:Principal,input:{organizationId:string;locationId:string}){
  await assertScope(principal,input.organizationId,input.locationId);
  const readiness=await getPilotReadiness(principal,input);
  if(!readiness.ready) throw httpError('pilot_readiness_blocked',409);

  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(
      `select id from pilot_runs where location_id=$1 and status in ('ready','active') for update`,
      [input.locationId]
    );
    if(current.rowCount) throw httpError('pilot_run_already_open',409);

    const created=await client.query(
      `insert into pilot_runs(
        organization_id,location_id,status,readiness_snapshot,created_by_actor_id
       ) values($1,$2,'ready',$3,$4) returning *`,
      [input.organizationId,input.locationId,JSON.stringify(readiness),principal.actorId??null]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload)
       values('pilot_run',$1,'PILOT_READY',$2,$3,$4)`,
      [created.rows[0].id,principal.actorId??null,principal.role,JSON.stringify({organizationId:input.organizationId,locationId:input.locationId})]
    );
    await client.query('commit');
    await audit(principal,'create_pilot_run','pilot_run',created.rows[0].id,'controlled_pilot_gate',{organizationId:input.organizationId,locationId:input.locationId});
    return created.rows[0];
  }catch(error){
    await client.query('rollback').catch(()=>{});
    throw error;
  }finally{client.release();}
}

export async function listPilotRuns(principal:Principal){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const scope=await getAdminActorScope(principal,pool);
  const result=await pool.query(
    `select pr.*,o.display_name as organization_name,l.name as location_name
       from pilot_runs pr
       join organizations o on o.id=pr.organization_id
       join locations l on l.id=pr.location_id
      where ($1::uuid is null or pr.organization_id=$1::uuid)
        and ($2::uuid is null or pr.location_id=$2::uuid)
      order by pr.created_at desc
      limit 100`,
    [scope?.organizationId??null,scope?.locationId??null]
  );
  return result.rows;
}

export async function startPilotRun(principal:Principal,pilotRunId:string){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(`select * from pilot_runs where id=$1 for update`,[pilotRunId]);
    if(!current.rowCount) throw httpError('pilot_run_not_found',404);
    const row=current.rows[0];
    await assertScope(principal,row.organization_id,row.location_id);
    if(row.status!=='ready') throw httpError('pilot_run_not_startable',409);

    const readiness=await getPilotReadiness(principal,{organizationId:row.organization_id,locationId:row.location_id});
    if(!readiness.ready) throw httpError('pilot_readiness_blocked',409);

    const updated=await client.query(
      `update pilot_runs
          set status='active',readiness_snapshot=$2,started_at=now(),updated_at=now()
        where id=$1 returning *`,
      [pilotRunId,JSON.stringify(readiness)]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload)
       values('pilot_run',$1,'PILOT_STARTED',$2,$3,$4)`,
      [pilotRunId,principal.actorId??null,principal.role,JSON.stringify({organizationId:row.organization_id,locationId:row.location_id})]
    );
    await client.query('commit');
    await audit(principal,'start_pilot_run','pilot_run',pilotRunId,'controlled_pilot_gate');
    return updated.rows[0];
  }catch(error){
    await client.query('rollback').catch(()=>{});
    throw error;
  }finally{client.release();}
}

export async function finishPilotRun(principal:Principal,pilotRunId:string,input:{
  outcome:'completed'|'aborted';
  abortReason?:string;
  evidence?:Record<string,unknown>;
}){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current=await client.query(`select * from pilot_runs where id=$1 for update`,[pilotRunId]);
    if(!current.rowCount) throw httpError('pilot_run_not_found',404);
    const row=current.rows[0];
    await assertScope(principal,row.organization_id,row.location_id);
    if(!['ready','active'].includes(row.status)) throw httpError('pilot_run_not_finishable',409);
    if(input.outcome==='completed'&&row.status!=='active') throw httpError('pilot_run_not_finishable',409);
    if(input.outcome==='aborted'&&!input.abortReason?.trim()) throw httpError('pilot_abort_reason_required',400);

    const updated=await client.query(
      `update pilot_runs
          set status=$2,
              evidence=coalesce(evidence,'{}'::jsonb)||$3::jsonb,
              completed_at=case when $2='completed' then now() else completed_at end,
              aborted_at=case when $2='aborted' then now() else aborted_at end,
              abort_reason=case when $2='aborted' then $4 else abort_reason end,
              updated_at=now()
        where id=$1 returning *`,
      [pilotRunId,input.outcome,JSON.stringify(input.evidence??{}),input.abortReason??null]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload)
       values('pilot_run',$1,$2,$3,$4,$5)`,
      [
        pilotRunId,
        input.outcome==='completed'?'PILOT_COMPLETED':'PILOT_ABORTED',
        principal.actorId??null,
        principal.role,
        JSON.stringify({evidence:input.evidence??{},abortReason:input.abortReason??null})
      ]
    );
    await client.query('commit');
    await audit(principal,input.outcome==='completed'?'complete_pilot_run':'abort_pilot_run','pilot_run',pilotRunId,'controlled_pilot_gate',{abortReason:input.abortReason??null});
    return updated.rows[0];
  }catch(error){
    await client.query('rollback').catch(()=>{});
    throw error;
  }finally{client.release();}
}
