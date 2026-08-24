import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent } from './orchestration.js';
import { audit } from './audit.js';
import { assertCaseAccess } from './case-access.js';

export async function createTriageAssessment(principal: Principal, input: {
  caseId:string; demandId?:string; source?:string; modelProvider?:string; modelName?:string;
  inputSnapshot?:Record<string,unknown>; symptomSummary?:string; suggestedCapabilities?:string[];
  suggestedDrivability?:string; safetyFlags?:unknown[]; evidence?:unknown[]; confidence?:number;
  requiresHumanReview?:boolean; actions?:Array<{ actionType:string; actionPayload?:Record<string,unknown> }>;
}) {
  await assertCaseAccess(principal,input.caseId);
  const r = await pool.query(
    `insert into ai_triage_assessments(case_id,demand_id,requested_by_actor_id,source,model_provider,model_name,input_snapshot,symptom_summary,suggested_capabilities,suggested_drivability,safety_flags,evidence,confidence,requires_human_review)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [input.caseId,input.demandId ?? null,principal.actorId ?? null,input.source ?? 'ai',input.modelProvider ?? null,input.modelName ?? null,
      JSON.stringify(input.inputSnapshot ?? {}),input.symptomSummary ?? null,JSON.stringify(input.suggestedCapabilities ?? []),input.suggestedDrivability ?? null,
      JSON.stringify(input.safetyFlags ?? []),JSON.stringify(input.evidence ?? []),input.confidence ?? null,input.requiresHumanReview ?? true]
  );
  const assessment = r.rows[0];
  for (const a of input.actions ?? []) {
    await pool.query('insert into ai_triage_actions(assessment_id,action_type,action_payload) values($1,$2,$3)',[assessment.id,a.actionType,JSON.stringify(a.actionPayload ?? {})]);
  }
  await appendCaseEvent(input.caseId,'AI_TRIAGE_PROPOSED',principal,{ assessmentId:assessment.id, confidence:assessment.confidence, safetyFlags:assessment.safety_flags });
  await audit(principal,'create_ai_triage','ai_triage_assessment',assessment.id,'advisory_only',{ caseId:input.caseId });
  return assessment;
}

export async function reviewTriageAssessment(principal: Principal, assessmentId:string, decision:'accepted'|'rejected', notes?:string) {
  if (!['admin','diagnostic','partner'].includes(principal.role)) throw new Error('forbidden');
  const current = await pool.query('select * from ai_triage_assessments where id=$1',[assessmentId]);
  if (!current.rowCount) throw new Error('assessment_not_found');
  const a = current.rows[0];
  await assertCaseAccess(principal,a.case_id);
  if (a.status !== 'proposed' && a.status !== 'reviewed') throw new Error('assessment_already_final');
  const r = await pool.query(
    `update ai_triage_assessments set status=$1,reviewed_by_actor_id=$2,reviewed_at=now(),review_notes=$3 where id=$4 returning *`,
    [decision,principal.actorId ?? null,notes ?? null,assessmentId]
  );
  await appendCaseEvent(a.case_id, decision === 'accepted' ? 'AI_TRIAGE_ACCEPTED' : 'AI_TRIAGE_REJECTED', principal,{ assessmentId, notes:notes ?? null });
  await audit(principal,'review_ai_triage','ai_triage_assessment',assessmentId,decision,{ caseId:a.case_id });
  return r.rows[0];
}

export async function decideTriageAction(principal: Principal, actionId:string, decision:'approved'|'rejected') {
  if (!['admin','diagnostic','partner'].includes(principal.role)) throw new Error('forbidden');
  const current = await pool.query(`select ta.*,aa.case_id from ai_triage_actions ta join ai_triage_assessments aa on aa.id=ta.assessment_id where ta.id=$1`,[actionId]);
  if (!current.rowCount) throw new Error('action_not_found');
  const a = current.rows[0];
  await assertCaseAccess(principal,a.case_id);
  if (a.state !== 'suggested') throw new Error('action_already_decided');
  const r = await pool.query(
    `update ai_triage_actions set state=$1,approved_by_actor_id=$2,approved_at=now() where id=$3 returning *`,
    [decision,principal.actorId ?? null,actionId]
  );
  await appendCaseEvent(a.case_id, decision === 'approved' ? 'AI_TRIAGE_ACTION_APPROVED' : 'AI_TRIAGE_ACTION_REJECTED', principal,{ actionId, actionType:a.action_type });
  await audit(principal,'review_ai_triage_action','ai_triage_action',actionId,decision,{ caseId:a.case_id, actionType:a.action_type });
  return r.rows[0];
}

export async function getCaseTriage(caseId:string) {
  const assessments = await pool.query('select * from ai_triage_assessments where case_id=$1 order by created_at desc',[caseId]);
  const ids = assessments.rows.map((x:any)=>x.id);
  const actions = ids.length ? await pool.query('select * from ai_triage_actions where assessment_id = any($1::uuid[]) order by created_at asc',[ids]) : { rows:[] } as any;
  return { assessments:assessments.rows, actions:actions.rows };
}
