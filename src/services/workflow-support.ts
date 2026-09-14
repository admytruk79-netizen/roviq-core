import { pool } from '../db/pool.js';

export async function createDeadline(
  caseId: string,
  deadlineType: string,
  dueAt: string,
  fallbackAction?: string,
  metadata: Record<string,unknown> = {}
) {
  const result = await pool.query(
    `insert into workflow_deadlines(case_id,deadline_type,due_at,fallback_action,metadata)
     values($1,$2,$3,$4,$5) returning *`,
    [caseId,deadlineType,dueAt,fallbackAction ?? null,JSON.stringify(metadata)]
  );
  return result.rows[0];
}

export async function raiseException(
  caseId: string,
  code: string,
  summary: string,
  severity = 'warning',
  metadata: Record<string,unknown> = {}
) {
  const result = await pool.query(
    `insert into case_exceptions(case_id,exception_code,severity,summary,metadata)
     values($1,$2,$3,$4,$5) returning *`,
    [caseId,code,severity,summary,JSON.stringify(metadata)]
  );
  return result.rows[0];
}
