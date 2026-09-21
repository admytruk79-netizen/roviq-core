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
    if((error as {code?:string}).code==='23505') throw httpError('pilot_run_already_open',409);
    throw error;
  }finally{client.release();}
}

async function assertCaseBelongsToPilot(caseId:string,organizationId:string,locationId:string){
  const linked=await pool.query(`
    select exists(
      select 1
      from service_cases sc
      left join actors owner on owner.id=sc.current_owner_actor_id
      left join actors selected on selected.id=sc.selected_actor_id
      left join actors recommended on recommended.id=sc.recommended_actor_id
      where sc.id=$1 and (
        (owner.organization_id=$2 and (owner.location_id=$3 or owner.location_id is null))
        or (selected.organization_id=$2 and (selected.location_id=$3 or selected.location_id is null))
        or (recommended.organization_id=$2 and (recommended.location_id=$3 or recommended.location_id is null))
        or exists(
          select 1 from matches_offers mo
          join actors provider on provider.id=mo.actor_id
          where mo.case_id=sc.id
            and mo.outcome='accepted'
            and provider.organization_id=$2
            and (provider.location_id=$3 or provider.location_id is null)
        )
      )
    ) as linked`,
    [caseId,organizationId,locationId]
  );
  if(!linked.rows[0]?.linked) throw httpError('pilot_case_scope_mismatch',409);
}

export async function listPilotRuns(principal:Principal){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const scope=await getAdminActorScope(principal,pool);
  const result=await pool.query(
    `select pr.*,o.display_name as organization_name,l.name as location_name,
       (select count(*)::int from pilot_run_cases prc where prc.pilot_run_id=pr.id) as case_count
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


export async function addPilotRunCase(principal:Principal,pilotRunId:string,caseId:string){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const run=await pool.query(`select * from pilot_runs where id=$1`,[pilotRunId]);
  if(!run.rowCount) throw httpError('pilot_run_not_found',404);
  const row=run.rows[0];
  await assertScope(principal,row.organization_id,row.location_id);
  if(!['ready','active'].includes(row.status)) throw httpError('pilot_run_not_open',409);
  await assertCaseBelongsToPilot(caseId,row.organization_id,row.location_id);
  await pool.query(
    `insert into pilot_run_cases(pilot_run_id,service_case_id,added_by_actor_id)
     values($1,$2,$3)
     on conflict(pilot_run_id,service_case_id) do nothing`,
    [pilotRunId,caseId,principal.actorId??null]
  );
  await audit(principal,'add_pilot_case','pilot_run',pilotRunId,'controlled_pilot_gate',{caseId});
  return getPilotRunCases(principal,pilotRunId);
}

export async function getPilotRunCases(principal:Principal,pilotRunId:string){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const run=await pool.query(`select * from pilot_runs where id=$1`,[pilotRunId]);
  if(!run.rowCount) throw httpError('pilot_run_not_found',404);
  const row=run.rows[0];
  await assertScope(principal,row.organization_id,row.location_id);
  const result=await pool.query(
    `select sc.id,sc.state,sc.priority,sc.created_at,sc.updated_at,prc.added_at
       from pilot_run_cases prc
       join service_cases sc on sc.id=prc.service_case_id
      where prc.pilot_run_id=$1
      order by prc.added_at asc,sc.id`,
    [pilotRunId]
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
    if(input.outcome==='completed'){
      const linkedCases=await client.query(
        `select sc.id,sc.state
           from pilot_run_cases prc
           join service_cases sc on sc.id=prc.service_case_id
          where prc.pilot_run_id=$1
          order by prc.added_at asc`,
        [pilotRunId]
      );
      if(!linkedCases.rowCount) throw httpError('pilot_case_required',409);
      if(linkedCases.rows.some((caseRow:any)=>!['completed','cancelled'].includes(caseRow.state))) throw httpError('pilot_cases_not_terminal',409);
      if(!linkedCases.rows.some((caseRow:any)=>caseRow.state==='completed')) throw httpError('pilot_completed_case_required',409);
    }
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
