import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent, raiseException } from './orchestration.js';

export async function sweepExpiredDeadlines(principal: Principal, limit=100) {
  const expired = await pool.query(
    `select * from workflow_deadlines where state='open' and due_at<=now() order by due_at asc limit $1`, [limit]
  );
  const processed: unknown[] = [];
  for (const d of expired.rows) {
    const nextRetry = d.retry_count + 1;
    if (nextRetry <= d.max_retries) {
      await pool.query('update workflow_deadlines set retry_count=$1,due_at=now()+interval \'2 minutes\' where id=$2',[nextRetry,d.id]);
      await appendCaseEvent(d.case_id,'WORKFLOW_RETRY_SCHEDULED',principal,{ deadlineId:d.id, deadlineType:d.deadline_type, retryCount:nextRetry, fallbackAction:d.fallback_action });
      processed.push({ id:d.id, action:'retry', retryCount:nextRetry });
    } else {
      await pool.query('update workflow_deadlines set state=\'expired\',resolved_at=now() where id=$1',[d.id]);
      const ex = await raiseException(d.case_id,`DEADLINE_${String(d.deadline_type).toUpperCase()}`,`Workflow deadline expired: ${d.deadline_type}`,'warning',{ deadlineId:d.id, fallbackAction:d.fallback_action });
      await appendCaseEvent(d.case_id,'WORKFLOW_ESCALATED',principal,{ deadlineId:d.id, exceptionId:ex.id, fallbackAction:d.fallback_action });
      processed.push({ id:d.id, action:'escalated', exceptionId:ex.id });
    }
  }
  return processed;
}

export async function setCustomerSnapshot(caseId:string, status:string, message?:string, nextAction?:string, etaAt?:string) {
  const r = await pool.query(
    `insert into case_snapshots(case_id,customer_status,customer_message,next_action,eta_at,updated_at)
     values($1,$2,$3,$4,$5,now()) on conflict(case_id) do update set customer_status=excluded.customer_status,
     customer_message=excluded.customer_message,next_action=excluded.next_action,eta_at=excluded.eta_at,updated_at=now() returning *`,
    [caseId,status,message ?? null,nextAction ?? null,etaAt ?? null]
  );
  return r.rows[0];
}

export async function queueNotification(input:{ caseId?:string; eventId?:string; channel:string; recipientType:string; recipientId:string; templateKey:string; payload?:Record<string,unknown> }) {
  const r = await pool.query(
    `insert into notification_outbox(case_id,event_id,channel,recipient_type,recipient_id,template_key,payload)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [input.caseId ?? null,input.eventId ?? null,input.channel,input.recipientType,input.recipientId,input.templateKey,JSON.stringify(input.payload ?? {})]
  );
  return r.rows[0];
}

export async function addLedgerEntry(input:{ caseId?:string; transactionId?:string; entryType:string; accountCode:string; counterpartyActorId?:string; amount:number; currency?:string; state?:string; externalReference?:string; metadata?:Record<string,unknown> }) {
  const r = await pool.query(
    `insert into ledger_entries(case_id,transaction_id,entry_type,account_code,counterparty_actor_id,amount,currency,state,external_reference,metadata)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [input.caseId ?? null,input.transactionId ?? null,input.entryType,input.accountCode,input.counterpartyActorId ?? null,input.amount,input.currency ?? 'USD',input.state ?? 'pending',input.externalReference ?? null,JSON.stringify(input.metadata ?? {})]
  );
  return r.rows[0];
}
