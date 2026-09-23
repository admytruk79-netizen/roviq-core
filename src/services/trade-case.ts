import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { loadCoreCaseForPrincipal } from './core-case-access.js';
import { startSaga, addSagaStep } from './saga-recovery.js';

type Queryable=Pick<PoolClient,'query'>;
export type TradePhase=
  |'sourcing'|'verification'|'commercial_quote'|'approval'|'compliance_documents'
  |'freight_booking'|'in_transit'|'destination_handoff'|'completed'|'cancelled';

const next:Record<TradePhase,ReadonlySet<TradePhase>>={
  sourcing:new Set(['verification','cancelled']),
  verification:new Set(['commercial_quote','sourcing','cancelled']),
  commercial_quote:new Set(['approval','verification','cancelled']),
  approval:new Set(['compliance_documents','commercial_quote','cancelled']),
  compliance_documents:new Set(['freight_booking','approval','cancelled']),
  freight_booking:new Set(['in_transit','compliance_documents','cancelled']),
  in_transit:new Set(['destination_handoff']),
  destination_handoff:new Set(['completed']),
  completed:new Set(),
  cancelled:new Set()
};

export function tradePhaseAllowed(from:TradePhase,to:TradePhase){return Boolean(next[from]?.has(to));}

export async function createTradeCase(input:{
  principal:Principal; tradeMode:'export'|'import'; originCountry:string; destinationCountry:string;
  originLocation?:string; destinationLocation?:string; subject?:Record<string,unknown>;
  marketId?:string; locationId?:string; priority?:'low'|'normal'|'high'|'urgent';
},client:PoolClient){
  const customerActorId=input.principal.role==='customer'?input.principal.actorId??null:null;
  const c=await client.query(`insert into core_cases(case_type,market_id,location_id,customer_actor_id,priority,requirements,constraints,attributes)
    values('trade',$1,$2,$3,$4,$5,$6,$7) returning *`,[
      input.marketId??null,input.locationId??null,customerActorId,input.priority??'normal',
      {tradeMode:input.tradeMode},
      {customerApprovalRequired:true},
      {originCountry:input.originCountry,destinationCountry:input.destinationCountry}
    ]);
  const core=c.rows[0];
  const t=await client.query(`insert into trade_cases(case_id,trade_mode,origin_country,destination_country,origin_location,destination_location,subject)
    values($1,$2,$3,$4,$5,$6,$7) returning *`,[
      core.id,input.tradeMode,input.originCountry,input.destinationCountry,
      input.originLocation??null,input.destinationLocation??null,input.subject??{}
    ]);
  for(const code of ['SOURCE_VERIFIED','COMMERCIAL_APPROVED','COMPLIANCE_READY','FREIGHT_BOOKED','DESTINATION_HANDOFF']){
    await client.query('insert into trade_case_milestones(case_id,milestone_code) values($1,$2)',[core.id,code]);
  }
  const correlationId=randomUUID();
  const payload={caseType:'trade',tradeMode:input.tradeMode,phase:'sourcing'};
  await client.query(`insert into core_case_events(case_id,actor_id,event_type,correlation_id,payload,previous_version,new_version)
    values($1,$2,'TRADE_CASE_CREATED',$3,$4,0,1)`,[core.id,input.principal.actorId??null,correlationId,payload]);
  await client.query(`insert into core_outbox(aggregate_type,aggregate_id,event_type,payload,correlation_id)
    values('case',$1,'TRADE_CASE_CREATED',$2,$3)`,[core.id,{caseId:core.id,...payload},correlationId]);
  const saga=await startSaga(core.id,'trade_orchestration',{phase:'sourcing'},client);
  await addSagaStep(saga.id,'source_subject',{tradeMode:input.tradeMode,subject:input.subject??{}},client);
  return {case:core,trade:t.rows[0],saga};
}

export async function loadTradeCase(principal:Principal,caseId:string,db:Queryable=pool){
  const c=await loadCoreCaseForPrincipal(principal,caseId,db);if(!c)return null;
  if(c.case_type!=='trade')throw new Error('not_trade_case');
  const [t,m,d]=await Promise.all([
    db.query('select * from trade_cases where case_id=$1',[caseId]),
    db.query('select * from trade_case_milestones where case_id=$1 order by created_at,id',[caseId]),
    db.query('select * from trade_documents where case_id=$1 order by created_at desc',[caseId])
  ]);
  if(!t.rowCount)throw new Error('trade_projection_missing');
  return {case:c,trade:t.rows[0],milestones:m.rows,documents:d.rows};
}

export async function advanceTradePhase(input:{
  principal:Principal; caseId:string; to:TradePhase; evidence?:Record<string,unknown>;
},client:PoolClient){
  await loadTradeCase(input.principal,input.caseId,client);
  const r=await client.query('select * from trade_cases where case_id=$1 for update',[input.caseId]);
  const current=r.rows[0] as {phase:TradePhase};
  if(!tradePhaseAllowed(current.phase,input.to))throw new Error('trade_phase_not_allowed');
  const milestoneByTarget:Partial<Record<TradePhase,string>>={
    verification:'SOURCE_VERIFIED',
    approval:'COMMERCIAL_APPROVED',
    freight_booking:'COMPLIANCE_READY',
    in_transit:'FREIGHT_BOOKED',
    completed:'DESTINATION_HANDOFF'
  };
  const required=milestoneByTarget[input.to];
  if(required){
    const m=await client.query('select state from trade_case_milestones where case_id=$1 and milestone_code=$2',[input.caseId,required]);
    if(!m.rowCount||!['completed','waived'].includes(m.rows[0].state))throw new Error('trade_milestone_incomplete');
  }
  const core=await client.query('select version from core_cases where id=$1 for update',[input.caseId]);
  if(!core.rowCount)throw new Error('case_not_found');
  const previousVersion=Number(core.rows[0].version),newVersion=previousVersion+1;
  await client.query('update core_cases set version=$2,updated_at=now() where id=$1',[input.caseId,newVersion]);
  const u=await client.query('update trade_cases set phase=$2,updated_at=now() where case_id=$1 returning *',[input.caseId,input.to]);
  const payload={from:current.phase,to:input.to,evidence:input.evidence??{}};
  const correlationId=randomUUID();
  await client.query(`insert into core_case_events(case_id,actor_id,event_type,correlation_id,payload,previous_version,new_version)
    values($1,$2,'TRADE_PHASE_CHANGED',$3,$4,$5,$6)`,[
      input.caseId,input.principal.actorId??null,correlationId,payload,previousVersion,newVersion
    ]);
  await client.query(`insert into core_outbox(aggregate_type,aggregate_id,event_type,payload,correlation_id)
    values('case',$1,'TRADE_PHASE_CHANGED',$2,$3)`,[input.caseId,{caseId:input.caseId,...payload,version:newVersion},correlationId]);
  return u.rows[0];
}

export async function setTradeMilestone(input:{
  principal:Principal; caseId:string; milestoneCode:string; state:'ready'|'completed'|'blocked'|'waived'; evidence?:Record<string,unknown>;
},client:PoolClient){
  await loadTradeCase(input.principal,input.caseId,client);
  const r=await client.query(`update trade_case_milestones
    set state=$3,evidence=$4,completed_at=case when $3 in ('completed','waived') then now() else null end,updated_at=now()
    where case_id=$1 and milestone_code=$2 returning *`,[input.caseId,input.milestoneCode,input.state,input.evidence??{}]);
  if(!r.rowCount)throw new Error('trade_milestone_not_found');
  return r.rows[0];
}

export async function addTradeDocument(input:{
  principal:Principal; caseId:string; documentType:string; externalReference?:string; metadata?:Record<string,unknown>;
},db:Queryable=pool){
  await loadTradeCase(input.principal,input.caseId,db);
  const r=await db.query(`insert into trade_documents(case_id,document_type,external_reference,metadata)
    values($1,$2,$3,$4) returning *`,[input.caseId,input.documentType,input.externalReference??null,input.metadata??{}]);
  return r.rows[0];
}
