import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { loadCoreCaseForPrincipal } from './core-case-access.js';
import { evaluateCorePolicy } from './core-policy.js';

type Queryable=Pick<PoolClient,'query'>;

function stableJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object'){
    const r=value as Record<string,unknown>;
    return `{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${stableJson(r[k])}`).join(',')}}`;
  }
  return JSON.stringify(value)??'null';
}
function hash(value:unknown){return createHash('sha256').update(stableJson(value)).digest('hex');}

async function appendAssignmentEvent(client:PoolClient,input:{
  caseId:string; actorId?:string|null; eventType:string; payload:Record<string,unknown>;
  previousVersion:number; newVersion:number; correlationId:string;
}){
  await client.query(`insert into core_case_events(case_id,actor_id,event_type,correlation_id,payload,payload_hash,previous_version,new_version)
    values($1,$2,$3,$4,$5,$6,$7,$8)`,[
      input.caseId,input.actorId??null,input.eventType,input.correlationId,input.payload,hash(input.payload),
      input.previousVersion,input.newVersion
    ]);
  await client.query(`insert into core_outbox(aggregate_type,aggregate_id,event_type,payload,correlation_id)
    values('case',$1,$2,$3,$4)`,[
      input.caseId,input.eventType,{caseId:input.caseId,...input.payload,version:input.newVersion},input.correlationId
    ]);
}

export async function createAssignmentOffer(input:{
  principal:Principal; caseId:string; actorId:string; expectedVersion:number;
  reason?:string; expiresInMinutes?:number; metadata?:Record<string,unknown>;
},client:PoolClient){
  const visible=await loadCoreCaseForPrincipal(input.principal,input.caseId,client);
  if(!visible)throw new Error('case_not_found');
  const q=await client.query('select * from core_cases where id=$1 for update',[input.caseId]);
  if(!q.rowCount)throw new Error('case_not_found');
  const locked=q.rows[0];
  if(Number(locked.version)!==input.expectedVersion)throw new Error('version_conflict');
  if(['completed','cancelled','expired'].includes(locked.state))throw new Error('terminal_case');

  const actor=await client.query(`select id,actor_type,status,organization_id,location_id,attributes
    from actors where id=$1`,[input.actorId]);
  if(!actor.rowCount)throw new Error('actor_not_found');
  if(actor.rows[0].status!=='active')throw new Error('actor_not_active');
  if(actor.rows[0].actor_type==='customer'||actor.rows[0].actor_type==='admin')throw new Error('actor_not_assignable');
  if(locked.current_owner_actor_id===input.actorId)throw new Error('actor_already_owner');

  const policy=await evaluateCorePolicy({
    action:'case.assignment.offer',principal:input.principal,caseRecord:locked,
    facts:{assignment:{actorId:input.actorId,actorType:actor.rows[0].actor_type}}
  },client);
  if(policy.decision==='deny')throw new Error('policy_denied');
  if(policy.decision==='require_review')throw new Error('policy_review_required');

  await client.query(`update core_assignment_offers set state='cancelled',updated_at=now(),reason=coalesce(reason,'Superseded by a newer offer')
    where case_id=$1 and state='pending'`,[input.caseId]);

  const nextVersion=Number(locked.version)+1;
  const expiresIn=Math.max(1,Math.min(120,input.expiresInMinutes??15));
  const offer=await client.query(`insert into core_assignment_offers(
      case_id,offered_to_actor_id,offered_by_actor_id,previous_owner_actor_id,state,
      expected_case_version,reason,metadata,expires_at
    ) values($1,$2,$3,$4,'pending',$5,$6,$7,now()+($8::text||' minutes')::interval)
    returning *`,[
      input.caseId,input.actorId,input.principal.actorId??null,locked.current_owner_actor_id??null,
      nextVersion,input.reason??null,input.metadata??{},expiresIn
    ]);
  await client.query('update core_cases set version=$2,updated_at=now() where id=$1',[input.caseId,nextVersion]);
  const correlationId=randomUUID();
  const payload={
    offerId:offer.rows[0].id,
    offeredToActorId:input.actorId,
    previousOwnerActorId:locked.current_owner_actor_id??null,
    expiresAt:offer.rows[0].expires_at,
    reason:input.reason??null
  };
  await appendAssignmentEvent(client,{
    caseId:input.caseId,actorId:input.principal.actorId,eventType:'CASE_ASSIGNMENT_OFFERED',
    payload,previousVersion:input.expectedVersion,newVersion:nextVersion,correlationId
  });
  return {offer:offer.rows[0],caseVersion:nextVersion};
}

export async function respondToAssignmentOffer(input:{
  principal:Principal; offerId:string; decision:'accepted'|'declined'; reason?:string;
},client:PoolClient){
  if(!input.principal.actorId)throw new Error('actor_required');
  const r=await client.query('select * from core_assignment_offers where id=$1 for update',[input.offerId]);
  if(!r.rowCount)throw new Error('assignment_offer_not_found');
  const offer=r.rows[0];
  if(offer.offered_to_actor_id!==input.principal.actorId)throw new Error('forbidden');
  if(offer.state!=='pending')throw new Error('assignment_offer_not_pending');
  if(new Date(offer.expires_at).getTime()<=Date.now()){
    await client.query(`update core_assignment_offers set state='expired',updated_at=now() where id=$1`,[input.offerId]);
    throw new Error('assignment_offer_expired');
  }

  const q=await client.query('select * from core_cases where id=$1 for update',[offer.case_id]);
  if(!q.rowCount)throw new Error('case_not_found');
  const locked=q.rows[0];
  if(Number(locked.version)!==Number(offer.expected_case_version)){
    await client.query(`update core_assignment_offers set state='stale',updated_at=now() where id=$1`,[input.offerId]);
    throw new Error('assignment_offer_stale');
  }
  if(['completed','cancelled','expired'].includes(locked.state)){
    await client.query(`update core_assignment_offers set state='stale',updated_at=now() where id=$1`,[input.offerId]);
    throw new Error('terminal_case');
  }

  if(input.decision==='accepted'){
    const policy=await evaluateCorePolicy({
      action:'case.assign',principal:input.principal,caseRecord:locked,
      facts:{assignment:{actorId:input.principal.actorId,source:'assignment_offer',offerId:input.offerId}}
    },client);
    if(policy.decision==='deny')throw new Error('policy_denied');
    if(policy.decision==='require_review')throw new Error('policy_review_required');
  }

  const previousVersion=Number(locked.version),nextVersion=previousVersion+1,correlationId=randomUUID();
  const nextOwner=input.decision==='accepted'?input.principal.actorId:locked.current_owner_actor_id;
  await client.query(`update core_cases set current_owner_actor_id=$2,version=$3,updated_at=now()
    where id=$1 and version=$4`,[offer.case_id,nextOwner,nextVersion,previousVersion]);
  const updated=await client.query(`update core_assignment_offers
    set state=$2,reason=coalesce($3,reason),responded_at=now(),updated_at=now()
    where id=$1 returning *`,[input.offerId,input.decision,input.reason??null]);

  const payload={
    offerId:input.offerId,
    offeredToActorId:offer.offered_to_actor_id,
    previousOwnerActorId:offer.previous_owner_actor_id??null,
    ownerActorId:nextOwner??null,
    decision:input.decision,
    reason:input.reason??null
  };
  await appendAssignmentEvent(client,{
    caseId:offer.case_id,actorId:input.principal.actorId,
    eventType:input.decision==='accepted'?'CASE_ASSIGNMENT_ACCEPTED':'CASE_ASSIGNMENT_DECLINED',
    payload,previousVersion,newVersion:nextVersion,correlationId
  });
  return {offer:updated.rows[0],caseVersion:nextVersion,ownerActorId:nextOwner??null};
}

export async function listAssignmentOffersForActor(principal:Principal,db:Queryable=pool){
  if(!principal.actorId)throw new Error('actor_required');
  const r=await db.query(`select o.*,c.case_type,c.state as case_state,c.priority,c.updated_at as case_updated_at
    from core_assignment_offers o join core_cases c on c.id=o.case_id
    where o.offered_to_actor_id=$1
      and o.state='pending'
      and o.expires_at>now()
    order by case when c.priority='urgent' then 0 when c.priority='high' then 1 else 2 end,o.created_at`,[principal.actorId]);
  return r.rows;
}

export async function listAssignmentOffersForCase(principal:Principal,caseId:string,db:Queryable=pool){
  const c=await loadCoreCaseForPrincipal(principal,caseId,db);
  if(!c)throw new Error('case_not_found');
  const r=await db.query(`select o.*,
    coalesce(a.attributes->>'displayName',a.attributes->>'name',a.legal_entity_id,a.actor_type) as offered_to_name,
    a.actor_type as offered_to_actor_type
    from core_assignment_offers o join actors a on a.id=o.offered_to_actor_id
    where o.case_id=$1 order by o.created_at desc limit 25`,[caseId]);
  return r.rows;
}
