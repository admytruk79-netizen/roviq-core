import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';
import { assertCaseAccess } from './case-access.js';

export type CaseState =
  | 'intake' | 'triage' | 'diagnostic_pending' | 'diagnostic_in_progress'
  | 'tow_pending' | 'tow_in_progress' | 'provider_selection' | 'provider_pending'
  | 'repair_in_progress' | 'parts_pending' | 'payment_pending' | 'completed' | 'cancelled';

export async function createServiceCase(principal: Principal, input: {
  demandId?: string; marketId?: string; locationId?: string; priority?: string;
  drivability?: string; attributes?: Record<string, unknown>;
}, transactionClient?:PoolClient) {
  const client = transactionClient ?? await pool.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query('begin');
    const domain = await client.query(`select id from domains where code='maintenance' limit 1`);
    if (!domain.rowCount) throw new Error('maintenance_domain_missing');
    const customerActorId = principal.role === 'customer' ? principal.actorId ?? null : null;
    const r = await client.query(
      `insert into service_cases(domain_id,demand_id,customer_actor_id,market_id,location_id,priority,drivability,attributes)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [domain.rows[0].id,input.demandId ?? null,customerActorId,input.marketId ?? null,input.locationId ?? null,input.priority ?? 'normal',input.drivability ?? 'unknown',JSON.stringify(input.attributes ?? {})]
    );
    const c = r.rows[0];
    const plan = await client.query(
      `insert into service_plans(case_id,status,current_revision,customer_summary,created_by_actor_id)
       values($1,'draft',1,'We are reviewing your vehicle concern and building the coordinated service plan.',$2) returning *`,
      [c.id,principal.actorId ?? null]
    );
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot,created_by_actor_id)
       values($1,1,'Case opened',$2,$3,$4)`,
      [plan.rows[0].id,plan.rows[0].customer_summary,JSON.stringify({state:'draft',tasks:[]}),principal.actorId ?? null]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('service_case',$1,'CASE_CREATED',$2,$3),
             ('service_case',$1,'SERVICE_PLAN_CREATED',$2,$4)`,
      [c.id,principal.actorId ?? null,JSON.stringify({state:c.state,priority:c.priority}),JSON.stringify({servicePlanId:plan.rows[0].id,revision:1})]
    );
    await client.query(
      `insert into audit_log(principal_role,principal_actor_id,action,object_type,object_id,rule_basis,metadata)
       values($1,$2,'create_case','service_case',$3,'maintenance_case_created',$4)`,
      [principal.role,principal.actorId ?? null,c.id,JSON.stringify({servicePlanId:plan.rows[0].id})]
    );
    if (ownsTransaction) await client.query('commit');
    return c;
  } catch (error) {
    if (ownsTransaction) await client.query('rollback');
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

export async function transitionCase(principal: Principal, caseId: string, toState: CaseState, metadata: Record<string, unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from service_cases where id=$1 for update',[caseId]);
    if (!current.rowCount) return null;
    const c = current.rows[0];
    await assertCaseAccess(principal,caseId,client);
    if (c.state === toState) { await client.query('commit'); return c; }
    if (toState === 'cancelled') {
      if (!['admin','customer'].includes(principal.role)) throw new Error('transition_forbidden');
    } else {
      const rule = await client.query(
        'select * from case_transition_rules where from_state=$1 and to_state=$2', [c.state,toState]
      );
      if (!rule.rowCount) throw new Error('invalid_case_transition');
      if (!rule.rows[0].allowed_roles.includes(principal.role)) throw new Error('transition_forbidden');
    }
    const terminalSql = toState === 'completed' ? ', completed_at=now()' : toState === 'cancelled' ? ', cancelled_at=now()' : '';
    const updated = await client.query(
      `update service_cases set state=$1, version=version+1, updated_at=now() ${terminalSql} where id=$2 returning *`,
      [toState,caseId]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('service_case',$1,$2,$3,$4)`,
      [caseId,`CASE_${toState.toUpperCase()}`,principal.actorId ?? null,JSON.stringify({ from:c.state,to:toState,...metadata })]
    );
    await client.query('commit');
    await audit(principal,'transition_case','service_case',caseId,`${c.state}->${toState}`,metadata);
    return updated.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

export async function appendCaseEvent(caseId: string, eventType: string, principal: Principal, payload: Record<string, unknown> = {}) {
  await pool.query(
    `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
     values('service_case',$1,$2,$3,$4)`,
    [caseId,eventType,principal.actorId ?? null,JSON.stringify(payload)]
  );
}

export async function getCaseTimeline(caseId: string) {
  const r = await pool.query(
    `select id,event_type,actor_id,occurred_at,payload from events
     where aggregate_type='service_case' and aggregate_id=$1 order by occurred_at asc`, [caseId]
  );
  return r.rows;
}

export async function createDeadline(caseId: string, deadlineType: string, dueAt: string, fallbackAction?: string, metadata: Record<string,unknown> = {}) {
  const r = await pool.query(
    `insert into workflow_deadlines(case_id,deadline_type,due_at,fallback_action,metadata)
     values($1,$2,$3,$4,$5) returning *`, [caseId,deadlineType,dueAt,fallbackAction ?? null,JSON.stringify(metadata)]
  );
  return r.rows[0];
}

export async function raiseException(caseId: string, code: string, summary: string, severity='warning', metadata: Record<string,unknown> = {}) {
  const r = await pool.query(
    `insert into case_exceptions(case_id,exception_code,severity,summary,metadata)
     values($1,$2,$3,$4,$5) returning *`, [caseId,code,severity,summary,JSON.stringify(metadata)]
  );
  return r.rows[0];
}

export async function withIdempotency<T>(principal: Principal, key: string | undefined, operation: string, body: unknown, fn: (transactionClient?:PoolClient) => Promise<{ status:number; body:T }>) {
  if (!key) return fn();
  if (key.length > 200) throw new Error('idempotency_key_too_long');
  const actorScope = principal.actorId ?? 'anonymous';
  const scopedKey = createHash('sha256').update(`${principal.role}|${actorScope}|${operation}|${key}`).digest('hex');
  const requestHash = createHash('sha256').update(stableJson(body ?? null)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into idempotency_keys(key,principal_role,principal_actor_id,operation,request_hash)
       values($1,$2,$3,$4,$5) on conflict(key) do nothing`,
      [scopedKey,principal.role,principal.actorId ?? null,operation,requestHash]
    );
    const existing = await client.query(
      `select principal_role,principal_actor_id,operation,request_hash,response_code,response_body,expires_at
       from idempotency_keys where key=$1 for update`,
      [scopedKey]
    );
    const row = existing.rows[0];
    const expired = row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
    if (expired) {
      await client.query(
        `update idempotency_keys set principal_role=$1,principal_actor_id=$2,operation=$3,request_hash=$4,
         response_code=null,response_body=null,created_at=now(),expires_at=now()+interval '24 hours' where key=$5`,
        [principal.role,principal.actorId ?? null,operation,requestHash,scopedKey]
      );
    } else if (row.request_hash !== requestHash || row.operation !== operation || row.principal_role !== principal.role || (row.principal_actor_id ?? null) !== (principal.actorId ?? null)) {
      throw new Error('idempotency_key_reused');
    } else if (row.response_code !== null) {
      await client.query('commit');
      return {status:row.response_code,body:row.response_body as T};
    }

    const result = await fn(client);
    await client.query(
      'update idempotency_keys set response_code=$1,response_body=$2 where key=$3',
      [result.status,JSON.stringify(result.body),scopedKey]
    );
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function stableJson(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string,unknown>;
    return `{${Object.keys(record).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
