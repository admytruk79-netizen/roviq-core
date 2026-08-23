import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

export type CaseState =
  | 'intake' | 'triage' | 'diagnostic_pending' | 'diagnostic_in_progress'
  | 'tow_pending' | 'tow_in_progress' | 'provider_selection' | 'provider_pending'
  | 'repair_in_progress' | 'parts_pending' | 'payment_pending' | 'completed' | 'cancelled';

export async function createServiceCase(principal: Principal, input: {
  demandId?: string; marketId?: string; locationId?: string; priority?: string;
  drivability?: string; attributes?: Record<string, unknown>;
}) {
  const domain = await pool.query(`select id from domains where code='maintenance' limit 1`);
  if (!domain.rowCount) throw new Error('maintenance_domain_missing');
  const customerActorId = principal.role === 'customer' ? principal.actorId ?? null : null;
  const r = await pool.query(
    `insert into service_cases(domain_id,demand_id,customer_actor_id,market_id,location_id,priority,drivability,attributes)
     values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [domain.rows[0].id,input.demandId ?? null,customerActorId,input.marketId ?? null,input.locationId ?? null,input.priority ?? 'normal',input.drivability ?? 'unknown',JSON.stringify(input.attributes ?? {})]
  );
  const c = r.rows[0];
  await appendCaseEvent(c.id,'CASE_CREATED',principal,{ state:c.state, priority:c.priority });
  await audit(principal,'create_case','service_case',c.id,'maintenance_case_created');
  return c;
}

export async function transitionCase(principal: Principal, caseId: string, toState: CaseState, metadata: Record<string, unknown> = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from service_cases where id=$1 for update',[caseId]);
    if (!current.rowCount) return null;
    const c = current.rows[0];
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

export async function withIdempotency<T>(principal: Principal, key: string | undefined, operation: string, body: unknown, fn: () => Promise<{ status:number; body:T }>) {
  if (!key) return fn();
  const existing = await pool.query('select response_code,response_body from idempotency_keys where key=$1 and expires_at>now()',[key]);
  if (existing.rowCount && existing.rows[0].response_code) return { status:existing.rows[0].response_code, body:existing.rows[0].response_body as T };
  const hash = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  await pool.query(
    `insert into idempotency_keys(key,principal_role,principal_actor_id,operation,request_hash)
     values($1,$2,$3,$4,$5) on conflict(key) do nothing`, [key,principal.role,principal.actorId ?? null,operation,hash]
  );
  const result = await fn();
  await pool.query('update idempotency_keys set response_code=$1,response_body=$2 where key=$3',[result.status,JSON.stringify(result.body),key]);
  return result;
}
