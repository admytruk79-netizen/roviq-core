import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent } from './orchestration.js';
import { assertCaseAccess } from './case-access.js';

export type ExceptionState = 'open' | 'acknowledged' | 'remediating' | 'resolved' | 'dismissed';

export async function updateExceptionState(principal: Principal, exceptionId: string, input: {
  state: ExceptionState;
  resolutionCode?: string;
  note?: string;
}) {
  if (principal.role !== 'admin') throw new Error('exception_admin_only');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from case_exceptions where id=$1 for update',[exceptionId]);
    if (!current.rowCount) throw new Error('exception_not_found');
    const row = current.rows[0];
    await assertCaseAccess(principal,row.case_id,client);

    const allowed: Record<string, ExceptionState[]> = {
      open:['acknowledged','remediating','resolved','dismissed'],
      acknowledged:['remediating','resolved','dismissed'],
      remediating:['acknowledged','resolved','dismissed'],
      resolved:[],
      dismissed:[]
    };
    if (row.state !== input.state && !(allowed[row.state] ?? []).includes(input.state)) {
      throw new Error('invalid_exception_transition');
    }
    if (input.state === 'resolved' && !input.resolutionCode) throw new Error('resolution_code_required');

    const historyEntry = {
      at:new Date().toISOString(),
      from:row.state,
      to:input.state,
      actorId:principal.actorId ?? null,
      note:input.note ?? null,
      resolutionCode:input.resolutionCode ?? null
    };
    const updated = await client.query(
      `update case_exceptions set state=$1,
         resolution_code=coalesce($2,resolution_code),
         remediation_history=coalesce(remediation_history,'[]'::jsonb) || $3::jsonb,
         resolved_at=case when $1 in ('resolved','dismissed') then now() else resolved_at end,
         resolved_by_actor_id=case when $1 in ('resolved','dismissed') then $4 else resolved_by_actor_id end
       where id=$5 returning *`,
      [input.state,input.resolutionCode ?? null,JSON.stringify([historyEntry]),principal.actorId ?? null,exceptionId]
    );
    await appendCaseEvent(row.case_id,'CASE_EXCEPTION_UPDATED',principal,{
      exceptionId,exceptionCode:row.exception_code,from:row.state,to:input.state,resolutionCode:input.resolutionCode ?? null
    },client);
    await client.query('commit');
    return updated.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function assignException(principal: Principal, exceptionId: string, input:{ ownerActorId?:string|null; dueAt?:string|null }) {
  if (principal.role !== 'admin') throw new Error('exception_admin_only');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current=await client.query('select * from case_exceptions where id=$1 for update',[exceptionId]);
    if(!current.rowCount) throw new Error('exception_not_found');
    const row=current.rows[0];
    await assertCaseAccess(principal,row.case_id,client);
    const updated=await client.query(
      `update case_exceptions set owner_actor_id=$1,due_at=$2 where id=$3 returning *`,
      [input.ownerActorId ?? null,input.dueAt ?? null,exceptionId]
    );
    await appendCaseEvent(row.case_id,'CASE_EXCEPTION_ASSIGNED',principal,{
      exceptionId,
      exceptionCode:row.exception_code,
      ownerActorId:input.ownerActorId ?? null,
      dueAt:input.dueAt ?? null
    },client);
    await client.query('commit');
    return updated.rows[0];
  } catch(error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function getExceptionQueue(input:{ state?:ExceptionState; severity?:string; limit?:number }={}) {
  const params:unknown[]=[];
  const clauses:string[]=[];
  if(input.state){params.push(input.state);clauses.push(`e.state=$${params.length}`);}
  if(input.severity){params.push(input.severity);clauses.push(`e.severity=$${params.length}`);}
  params.push(input.limit ?? 200);
  const where=clauses.length?`where ${clauses.join(' and ')}`:'';
  const r=await pool.query(
    `select e.*,c.state as case_state,c.priority,c.updated_at as case_updated_at
     from case_exceptions e join service_cases c on c.id=e.case_id ${where}
     order by case when e.severity='critical' then 0 when e.severity='warning' then 1 else 2 end,
       e.due_at nulls last,e.created_at asc limit $${params.length}`,
    params
  );
  return r.rows;
}
