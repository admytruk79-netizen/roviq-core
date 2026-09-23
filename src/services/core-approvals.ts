import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { loadCoreCaseForPrincipal } from './core-case-access.js';

type Queryable=Pick<PoolClient,'query'>;

export async function requestCoreApproval(input:{
  principal:Principal; caseId:string; approvalType:string; action:string;
  requestedFromActorId:string; payload?:Record<string,unknown>; expiresAt?:Date|null;
},db:Queryable=pool){
  const c=await loadCoreCaseForPrincipal(input.principal,input.caseId,db);
  if(!c)throw new Error('case_not_found');
  const r=await db.query(`insert into core_approvals(case_id,approval_type,action,requested_from_actor_id,requested_by_actor_id,expected_case_version,payload,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [input.caseId,input.approvalType,input.action,input.requestedFromActorId,input.principal.actorId??null,Number(c.version),input.payload??{},input.expiresAt??null]);
  return r.rows[0];
}

export async function decideCoreApproval(input:{
  principal:Principal; caseId:string; approvalId:string; decision:'approved'|'rejected'; reason?:string;
},db:Queryable=pool){
  const c=await loadCoreCaseForPrincipal(input.principal,input.caseId,db);
  if(!c)throw new Error('case_not_found');
  const r=await db.query('select * from core_approvals where id=$1 and case_id=$2 for update',[input.approvalId,input.caseId]);
  if(!r.rowCount)throw new Error('approval_not_found');
  const a=r.rows[0];
  if(a.state!=='pending')throw new Error('approval_already_decided');
  if(a.expires_at&&new Date(a.expires_at).getTime()<=Date.now())throw new Error('approval_expired');
  if(input.principal.role!=='admin'&&a.requested_from_actor_id!==input.principal.actorId)throw new Error('forbidden');
  const u=await db.query(`update core_approvals set state=$3,reason=$4,decided_at=now(),decided_by_actor_id=$5,updated_at=now()
    where id=$1 and case_id=$2 and state='pending' returning *`,
    [input.approvalId,input.caseId,input.decision,input.reason??null,input.principal.actorId??null]);
  if(!u.rowCount)throw new Error('approval_already_decided');
  return u.rows[0];
}

export async function listCoreApprovals(principal:Principal,caseId:string,db:Queryable=pool){
  const c=await loadCoreCaseForPrincipal(principal,caseId,db);if(!c)throw new Error('case_not_found');
  const r=await db.query('select * from core_approvals where case_id=$1 order by created_at desc',[caseId]);return r.rows;
}
