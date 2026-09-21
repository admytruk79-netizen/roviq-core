import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';
import { getAdminActorScope } from './admin-case-scope.js';
import { getPilotReadiness } from './pilot-readiness.js';

function httpError(message:string,statusCode:number){
  return Object.assign(new Error(message),{statusCode});
}

const REQUIRED_COMPLETION_EVIDENCE=['scheduling','repairOrder','notifications','payments','reconciliation'] as const;
function evidenceSatisfied(value:unknown){
  return value===true || (typeof value==='string'&&['passed','verified','completed'].includes(value.toLowerCase()));
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
        exists(
          select 1 from locations case_location
          where case_location.id=sc.location_id
            and case_location.id=$3
            and case_location.organization_id=$2
        )
        or (owner.organization_id=$2 and (owner.location_id=$3 or owner.location_id is null))
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


async function completionOperationalBlockers(client:{query:(text:string,params?:unknown[])=>Promise<any>},pilotRunId:string){
  const [notifications,exceptions,providerEvents,disputes,payouts,recovery]=await Promise.all([
    client.query(
      `select n.id,n.state,n.attempt_count,n.last_error
         from notification_outbox n
         join pilot_run_cases prc on prc.service_case_id=n.case_id
        where prc.pilot_run_id=$1
          and (n.state='dead' or (n.state='pending' and coalesce(n.attempt_count,0)>0))
        order by n.created_at asc`,
      [pilotRunId]
    ),
    client.query(
      `select ce.id,ce.exception_code,ce.severity,ce.state
         from case_exceptions ce
         join pilot_run_cases prc on prc.service_case_id=ce.case_id
        where prc.pilot_run_id=$1
          and ce.state='open'
          and ce.severity='critical'
        order by ce.created_at asc`,
      [pilotRunId]
    ),
    client.query(
      `select ppe.id,ppe.provider_event_id,ppe.event_type,ppe.error_message
         from payment_provider_events ppe
         join payment_intents pi on pi.id=ppe.related_payment_intent_id
         join pilot_run_cases prc on prc.service_case_id=pi.case_id
        where prc.pilot_run_id=$1
          and ppe.processing_state='failed'
        order by ppe.received_at asc`,
      [pilotRunId]
    ),
    client.query(
      `select d.id,d.external_reference,d.status
         from payment_disputes d
         join payment_intents pi on pi.id=d.payment_intent_id
         join pilot_run_cases prc on prc.service_case_id=pi.case_id
        where prc.pilot_run_id=$1
          and d.status in ('needs_response','under_review')
        order by d.opened_at asc`,
      [pilotRunId]
    ),
    client.query(
      `select sp.id,sp.state,sp.provider,sp.provider_payout_id
         from settlement_payouts sp
         join pilot_run_cases prc on prc.service_case_id=sp.case_id
        where prc.pilot_run_id=$1
          and sp.state in ('pending','approved','processing','failed')
        order by sp.created_at asc`,
      [pilotRunId]
    ),
    client.query(
      `select fp.id,fp.service_case_id,fp.status,fp.recovery_reason
         from fulfillment_plans fp
         join pilot_run_cases prc on prc.service_case_id=fp.service_case_id
        where prc.pilot_run_id=$1
          and fp.status not in ('superseded','completed','cancelled')
          and fp.recovery_required_at is not null
        order by fp.updated_at asc`,
      [pilotRunId]
    )
  ]);
  return [
    ...notifications.rows.map((row:any)=>({kind:'notification_delivery',id:row.id,state:row.state,attemptCount:Number(row.attempt_count??0),error:row.last_error??null})),
    ...exceptions.rows.map((row:any)=>({kind:'critical_exception',id:row.id,code:row.exception_code,severity:row.severity})),
    ...providerEvents.rows.map((row:any)=>({kind:'payment_provider_event',id:row.id,providerEventId:row.provider_event_id,eventType:row.event_type,error:row.error_message??null})),
    ...disputes.rows.map((row:any)=>({kind:'payment_dispute',id:row.id,reference:row.external_reference,status:row.status})),
    ...payouts.rows.map((row:any)=>({kind:'partner_settlement',id:row.id,state:row.state,provider:row.provider,providerReference:row.provider_payout_id??null})),
    ...recovery.rows.map((row:any)=>({kind:'fulfillment_recovery',id:row.id,caseId:row.service_case_id,status:row.status,reason:row.recovery_reason??null}))
  ];
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
      const evidence=input.evidence??{};
      const missing=REQUIRED_COMPLETION_EVIDENCE.filter((key)=>!evidenceSatisfied(evidence[key]));
      if(missing.length) throw Object.assign(new Error('pilot_evidence_incomplete'),{statusCode:409,missingEvidence:missing});
      const blockers=await completionOperationalBlockers(client,pilotRunId);
      if(blockers.length) throw Object.assign(new Error('pilot_operational_blockers'),{statusCode:409,blockers});
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


export async function getPilotRunHealth(principal:Principal,pilotRunId:string){
  if(principal.role!=='admin') throw httpError('forbidden',403);
  const runResult=await pool.query(`select * from pilot_runs where id=$1`,[pilotRunId]);
  if(!runResult.rowCount) throw httpError('pilot_run_not_found',404);
  const run=runResult.rows[0];
  await assertScope(principal,run.organization_id,run.location_id);

  const [cases,delivery,exceptions,providerEvents,disputes,payouts,recovery]=await Promise.all([
    pool.query(
      `select sc.state,count(*)::int as total
         from pilot_run_cases prc
         join service_cases sc on sc.id=prc.service_case_id
        where prc.pilot_run_id=$1
        group by sc.state`,
      [pilotRunId]
    ),
    pool.query(
      `select
         count(*) filter(where n.state='dead')::int as dead,
         count(*) filter(where n.state='pending' and coalesce(n.attempt_count,0)>0)::int as retrying
       from notification_outbox n
       join pilot_run_cases prc on prc.service_case_id=n.case_id
      where prc.pilot_run_id=$1`,
      [pilotRunId]
    ),
    pool.query(
      `select
         count(*) filter(where ce.state='open')::int as open,
         count(*) filter(where ce.state='open' and ce.severity='critical')::int as critical
       from case_exceptions ce
       join pilot_run_cases prc on prc.service_case_id=ce.case_id
      where prc.pilot_run_id=$1`,
      [pilotRunId]
    ),
    pool.query(
      `select count(*)::int as failed
       from payment_provider_events ppe
       join payment_intents pi on pi.id=ppe.related_payment_intent_id
       join pilot_run_cases prc on prc.service_case_id=pi.case_id
      where prc.pilot_run_id=$1
        and ppe.processing_state='failed'`,
      [pilotRunId]
    ),
    pool.query(
      `select count(*)::int as open
         from payment_disputes d
         join payment_intents pi on pi.id=d.payment_intent_id
         join pilot_run_cases prc on prc.service_case_id=pi.case_id
        where prc.pilot_run_id=$1
          and d.status in ('needs_response','under_review')`,
      [pilotRunId]
    ),
    pool.query(
      `select
         count(*) filter(where sp.state='failed')::int as failed,
         count(*) filter(where sp.state in ('pending','approved','processing'))::int as in_flight
       from settlement_payouts sp
       join pilot_run_cases prc on prc.service_case_id=sp.case_id
      where prc.pilot_run_id=$1`,
      [pilotRunId]
    ),
    pool.query(
      `select count(*)::int as required
         from fulfillment_plans fp
         join pilot_run_cases prc on prc.service_case_id=fp.service_case_id
        where prc.pilot_run_id=$1
          and fp.status not in ('superseded','completed','cancelled')
          and fp.recovery_required_at is not null`,
      [pilotRunId]
    )
  ]);
  const caseStates=Object.fromEntries(cases.rows.map((row:any)=>[row.state,Number(row.total)]));
  const operational={
    notifications:{
      dead:Number(delivery.rows[0]?.dead??0),
      retrying:Number(delivery.rows[0]?.retrying??0)
    },
    exceptions:{
      open:Number(exceptions.rows[0]?.open??0),
      critical:Number(exceptions.rows[0]?.critical??0)
    },
    paymentProviderEvents:{
      failed:Number(providerEvents.rows[0]?.failed??0)
    },
    disputes:{
      open:Number(disputes.rows[0]?.open??0)
    },
    settlements:{
      failed:Number(payouts.rows[0]?.failed??0),
      inFlight:Number(payouts.rows[0]?.in_flight??0)
    },
    fulfillment:{
      recoveryRequired:Number(recovery.rows[0]?.required??0)
    }
  };

  if(['completed','aborted'].includes(run.status)){
    return {
      pilotRunId,
      runStatus:run.status,
      status:'closed' as const,
      readiness:null,
      caseStates,
      operational
    };
  }

  const readiness=await getPilotReadiness(principal,{
    organizationId:run.organization_id,
    locationId:run.location_id
  });
  const runtimeCritical=
    operational.notifications.dead+
    operational.exceptions.critical+
    operational.paymentProviderEvents.failed+
    operational.settlements.failed+
    operational.fulfillment.recoveryRequired;
  const runtimeWarnings=
    operational.notifications.retrying+
    Math.max(0,operational.exceptions.open-operational.exceptions.critical)+
    operational.disputes.open+
    operational.settlements.inFlight;
  return {
    pilotRunId,
    runStatus:run.status,
    status:!readiness.ready||runtimeCritical>0?'degraded' as const:(readiness.warningCount>0||runtimeWarnings>0)?'attention' as const:'healthy' as const,
    readiness,
    caseStates,
    operational
  };
}
