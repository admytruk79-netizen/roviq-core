import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';
import { audit } from './audit.js';

export async function getServicePlan(principal:Principal, caseId:string) {
  await assertCaseAccess(principal,caseId);
  const plan = await pool.query('select * from service_plans where case_id=$1',[caseId]);
  if (!plan.rowCount) return null;
  const planId = plan.rows[0].id;
  const [revisions,tasks,commitments,approvals,quotes] = await Promise.all([
    pool.query('select * from service_plan_revisions where service_plan_id=$1 order by revision desc',[planId]),
    pool.query('select * from service_plan_tasks where service_plan_id=$1 order by revision desc,sequence asc,created_at asc',[planId]),
    pool.query('select * from case_commitments where service_plan_id=$1 order by created_at desc',[planId]),
    pool.query('select * from case_approvals where service_plan_id=$1 order by created_at desc',[planId]),
    pool.query('select * from service_quotes where service_plan_id=$1 order by revision desc',[planId])
  ]);
  return { plan:plan.rows[0], revisions:revisions.rows, tasks:tasks.rows, commitments:commitments.rows, approvals:approvals.rows, quotes:quotes.rows };
}

export async function reviseServicePlan(principal:Principal, caseId:string, input:{
  changeReason:string;
  customerSummary?:string;
  estimatedTotalMinor?:number;
  currency?:string;
  tasks?:Array<{ taskType:string; title:string; instructions?:string; dueAt?:string; estimatedAmountMinor?:number; currency?:string; metadata?:Record<string,unknown> }>;
}) {
  if (principal.role !== 'admin') throw new Error('forbidden');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCaseAccess(principal,caseId,client);
    const current = await client.query('select * from service_plans where case_id=$1 for update',[caseId]);
    if (!current.rowCount) throw new Error('service_plan_not_found');
    const plan = current.rows[0];
    const revision = Number(plan.current_revision) + 1;
    const tasks = input.tasks ?? [];
    const snapshot = { customerSummary:input.customerSummary ?? plan.customer_summary, estimatedTotalMinor:input.estimatedTotalMinor ?? plan.estimated_total_minor, currency:input.currency ?? plan.currency, tasks };

    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot,estimated_total_minor,currency,created_by_actor_id)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [plan.id,revision,input.changeReason,input.customerSummary ?? plan.customer_summary,JSON.stringify(snapshot),input.estimatedTotalMinor ?? plan.estimated_total_minor,input.currency ?? plan.currency,principal.actorId ?? null]
    );
    for (const [index,task] of tasks.entries()) {
      await client.query(
        `insert into service_plan_tasks(service_plan_id,revision,task_type,sequence,title,instructions,due_at,estimated_amount_minor,currency,metadata)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [plan.id,revision,task.taskType,index,task.title,task.instructions ?? null,task.dueAt ?? null,task.estimatedAmountMinor ?? null,task.currency ?? input.currency ?? plan.currency,JSON.stringify(task.metadata ?? {})]
      );
    }
    const updated = await client.query(
      `update service_plans set current_revision=$1,status='proposed',customer_summary=$2,estimated_total_minor=$3,currency=$4,updated_at=now()
       where id=$5 returning *`,
      [revision,input.customerSummary ?? plan.customer_summary,input.estimatedTotalMinor ?? plan.estimated_total_minor,input.currency ?? plan.currency,plan.id]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('service_case',$1,'SERVICE_PLAN_REVISED',$2,$3)`,
      [caseId,principal.actorId ?? null,JSON.stringify({ servicePlanId:plan.id, revision, changeReason:input.changeReason })]
    );
    await client.query('commit');
    await audit(principal,'revise_service_plan','service_plan',plan.id,input.changeReason,{caseId,revision});
    return updated.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
