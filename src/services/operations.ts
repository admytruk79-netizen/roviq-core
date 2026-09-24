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
  // Centralized here rather than added to each of setCustomerSnapshot's ~10 call sites: every
  // existing caller (field-service.ts, transport.ts, orchestration.ts, ...) already computes the
  // right plain-language message for this snapshot, so this is the one place that turns it into
  // actual outbound notifications instead of only something the customer portal has to be open and
  // polling to see. Queued through the same channel/outbox as everything else -- safe to ship even
  // with no provider configured: sms/email start disabled (011_notifications_delivery.sql) and
  // simply dead-letter until an admin enables one with real credentials (Twilio for sms, Resend for
  // email), while push starts enabled but silently dead-letters for any actor with no subscribed
  // device on file (see notifications.ts). Never let a failure here take down the snapshot write
  // itself, which every caller depends on succeeding.
  if (message) {
    const c = await pool.query('select customer_actor_id from service_cases where id=$1',[caseId]);
    const customerActorId = c.rows[0]?.customer_actor_id as string|undefined;
    if (customerActorId) {
      const payload = { status, message, nextAction:nextAction ?? '', etaAt:etaAt ?? '' };
      for (const channel of ['sms','email','push'] as const) {
        try {
          await queueNotification({ caseId, channel, recipientType:'actor', recipientId:customerActorId, templateKey:'customer_status_update', payload });
        } catch (error) {
          console.warn('customer_notification_queue_failed', { caseId, channel, error:error instanceof Error?error.message:'unknown_error' });
        }
      }
    }
  }
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


export async function getOperationalHealthSummary(){
  const [
    migration,
    deadlines,
    exceptions,
    notifications,
    webhooks,
    connections,
    fulfillment
  ]=await Promise.all([
    pool.query(`select filename,applied_at,duration_ms from schema_migrations order by filename desc limit 1`),
    pool.query(`
      select
        count(*) filter(where state='open')::int as open,
        count(*) filter(where state='open' and due_at<=now())::int as overdue
      from workflow_deadlines`),
    pool.query(`
      select
        count(*) filter(where state='open')::int as open,
        count(*) filter(where state='open' and severity='critical')::int as critical,
        count(*) filter(where state='open' and severity='warning')::int as warning
      from case_exceptions`),
    pool.query(`
      select
        count(*) filter(where state='pending' and coalesce(attempt_count,0)>0)::int as retrying,
        count(*) filter(where state='dead')::int as dead
      from notification_outbox`),
    pool.query(`
      select
        count(*) filter(where state='retry')::int as retrying,
        count(*) filter(where state='dead')::int as dead
      from webhook_deliveries`),
    pool.query(`
      select
        count(*) filter(where connection_status in ('degraded','failed'))::int as degraded,
        count(*) filter(where connection_status='paused')::int as paused
      from partner_system_connections`),
    pool.query(`
      select
        count(*) filter(where status='blocked')::int as blocked,
        count(*) filter(where recovery_required_at is not null and status not in ('completed','cancelled','superseded'))::int as recovery_required
      from fulfillment_plans`)
  ]);

  const snapshot={
    database:{reachable:true,latestMigration:migration.rows[0]??null},
    workflow:{
      openDeadlines:Number(deadlines.rows[0]?.open??0),
      overdueDeadlines:Number(deadlines.rows[0]?.overdue??0)
    },
    exceptions:{
      open:Number(exceptions.rows[0]?.open??0),
      critical:Number(exceptions.rows[0]?.critical??0),
      warning:Number(exceptions.rows[0]?.warning??0)
    },
    notifications:{
      retrying:Number(notifications.rows[0]?.retrying??0),
      dead:Number(notifications.rows[0]?.dead??0)
    },
    webhooks:{
      retrying:Number(webhooks.rows[0]?.retrying??0),
      dead:Number(webhooks.rows[0]?.dead??0)
    },
    integrations:{
      degraded:Number(connections.rows[0]?.degraded??0),
      paused:Number(connections.rows[0]?.paused??0)
    },
    fulfillment:{
      blocked:Number(fulfillment.rows[0]?.blocked??0),
      recoveryRequired:Number(fulfillment.rows[0]?.recovery_required??0)
    }
  };
  const criticalSignals=[
    snapshot.exceptions.critical,
    snapshot.notifications.dead,
    snapshot.webhooks.dead,
    snapshot.integrations.degraded,
    snapshot.fulfillment.recoveryRequired
  ].reduce((sum,value)=>sum+value,0);
  const warningSignals=
    snapshot.workflow.overdueDeadlines+
    snapshot.exceptions.warning+
    snapshot.notifications.retrying+
    snapshot.webhooks.retrying+
    snapshot.integrations.paused+
    snapshot.fulfillment.blocked;
  return {
    generatedAt:new Date().toISOString(),
    status:criticalSignals>0?'degraded':warningSignals>0?'attention':'healthy',
    criticalSignals,
    warningSignals,
    ...snapshot
  };
}
