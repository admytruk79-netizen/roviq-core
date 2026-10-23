import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { validIdentityId } from '../../services/audit.js';
import { loadActorQualifications } from '../../services/serviceability-gate.js';
import { assertAdminCaseScope } from '../../services/admin-case-scope.js';
import { reassessCredentialImpact } from '../../services/qualification-impact.js';
import { requireRole } from '../middleware/principal.js';

const kinds = z.enum(['legal_license','oem_certification','manufacturer_access','training','equipment','facility','parts','capacity','authorization']);
const review = z.object({
  expectedVersion: z.number().int().min(0),
  requirementKey: z.string().trim().min(1).max(150), kind: kinds,
  scope: z.string().trim().min(1).max(200).nullable(),
  status: z.enum(['verified','unverified','expired','revoked']),
  source: z.string().trim().min(3).max(500),
  validUntil: z.string().datetime().nullable(),
  reason: z.string().trim().min(5).max(500)
}).strict().refine(v => v.status !== 'verified' || v.validUntil === null || Date.parse(v.validUntil) > Date.now(),
  'Verified evidence must have a future expiry or explicitly no expiry');

export async function qualificationAdminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole('admin') };
  app.get('/api/admin/qualifications/actors', admin, async (req) => {
    const { search } = z.object({ search: z.string().trim().max(150).default('') }).parse(req.query);
    const actors = await pool.query(`select a.id,a.actor_type,a.status,a.organization_id,o.display_name as business_name,
      a.attributes->>'displayName' as display_name from actors a
      left join organizations o on o.id=a.organization_id
      where a.actor_type <> 'customer' and ($1='' or a.id::text=$1 or o.display_name ilike '%' || $1 || '%'
        or a.attributes->>'displayName' ilike '%' || $1 || '%') order by o.display_name,a.id limit 101`, [search]);
    return { actors: actors.rows.slice(0,100), truncated: actors.rows.length > 100 };
  });

  app.get('/api/admin/qualifications/:actorId', admin, async (req, reply) => {
    const { actorId } = z.object({ actorId: z.string().uuid() }).parse(req.params);
    const actor = await pool.query('select id from actors where id=$1', [actorId]);
    if (!actor.rowCount) return reply.code(404).send({ error: 'actor_not_found' });
    const [evidence, history] = await Promise.all([
      pool.query(`select *,case when evidence_status='verified' and nullif(btrim(verified_source),'') is null then 'unverified'
        when evidence_status='verified' and valid_until<=clock_timestamp() then 'expired'
        else evidence_status end as effective_status from actor_qualification_evidence where actor_id=$1 order by updated_at desc,id`, [actorId]),
      pool.query(`select id,principal_identity_id,occurred_at,metadata from audit_log
        where action='review_actor_qualification' and metadata->>'actorId'=$1 order by occurred_at desc,id desc limit 100`, [actorId])
    ]);
    return { evidence: evidence.rows, history: history.rows };
  });

  // Read-only explanation for requirements already registered on a case. It does not grant work.
  app.get('/api/admin/qualifications/:actorId/cases/:caseId', admin, async (req, reply) => {
    const p = z.object({ actorId: z.string().uuid(), caseId: z.string().uuid() }).parse(req.params);
    const exists = await pool.query(`select 1 from service_cases where id=$1 and exists(select 1 from actors where id=$2)`, [p.caseId,p.actorId]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'case_or_actor_not_found' });
    const at = new Date();
    return { evaluation: await loadActorQualifications(p.caseId,p.actorId,pool,at), evaluatedAt: at.toISOString() };
  });

  // Stable evidence UUID + expectedVersion=0 creates; later reviews must name the current version.
  app.put('/api/admin/qualifications/:actorId/:evidenceId', admin, async (req, reply) => {
    const p = z.object({ actorId: z.string().uuid(), evidenceId: z.string().uuid() }).parse(req.params);
    const identity = validIdentityId(req.principal.identityId);
    if (!identity) return reply.code(403).send({ error: 'identified_admin_required' });
    const input = review.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`qualification:${p.evidenceId}`]);
      // Same actor lock as authoritative provider selection: review and selection serialize.
      const actor = await client.query('select id,actor_type,status from actors where id=$1 for update', [p.actorId]);
      if (!actor.rowCount) { await client.query('rollback'); return reply.code(404).send({ error: 'actor_not_found' }); }
      if (actor.rows[0].actor_type === 'customer' || (input.status === 'verified' && actor.rows[0].status !== 'active')) {
        await client.query('rollback'); return reply.code(409).send({ error: 'actor_not_verifiable' });
      }
      const before = (await client.query('select * from actor_qualification_evidence where id=$1 for update', [p.evidenceId])).rows[0];
      if ((before && before.actor_id !== p.actorId) || (before?.review_version ?? 0) !== input.expectedVersion) {
        await client.query('rollback'); return reply.code(409).send({ error: 'qualification_changed_reload' });
      }
      if (before && (before.requirement_key !== input.requirementKey || before.kind !== input.kind || before.scope !== input.scope)) {
        await client.query('rollback'); return reply.code(409).send({ error: 'qualification_subject_immutable' });
      }
      const result = await client.query(`insert into actor_qualification_evidence
        (id,actor_id,requirement_key,kind,scope,evidence_status,verified_source,verified_by,valid_until,
          review_version,review_reason,reviewed_by_identity_id,reviewed_at)
        values($1,$2,$3,$4,$5,$6,$7,case when $6='verified' then $8::text else null end,$9,1,$10,$8::uuid,clock_timestamp())
        on conflict(id) do update set evidence_status=excluded.evidence_status,verified_source=excluded.verified_source,
          verified_by=excluded.verified_by,valid_until=excluded.valid_until,review_version=actor_qualification_evidence.review_version+1,
          review_reason=excluded.review_reason,reviewed_by_identity_id=excluded.reviewed_by_identity_id,
          reviewed_at=excluded.reviewed_at,updated_at=clock_timestamp() returning *`,
      [p.evidenceId,p.actorId,input.requirementKey,input.kind,input.scope,input.status,input.source,identity,input.validUntil,input.reason]);
      await client.query(`insert into audit_log(principal_role,principal_identity_id,action,object_type,object_id,metadata)
        values('admin',$1,'review_actor_qualification','actor_qualification_evidence',$2,$3)`,
      [identity,p.evidenceId,JSON.stringify({ actorId:p.actorId,before:before ?? null,after:result.rows[0] })]);
      const impactedCases = input.status !== 'verified'
        ? await reassessCredentialImpact(client,req.principal,p.actorId,input.requirementKey,input.kind)
        : [];
      await client.query('commit');
      return { evidence:result.rows[0], impactedCases };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  });
  // An identified administrator may activate a specific requirement on a case.
  // Once provider selection begins this endpoint is closed: change management
  // must go through the existing case exception/reassessment workflow.
  app.put('/api/admin/qualifications/cases/:caseId/requirements/:requirementKey', admin, async (req, reply) => {
    const params = z.object({
      caseId: z.string().uuid(), requirementKey: z.string().trim().min(1).max(150)
    }).parse(req.params);
    const body = z.object({
      kind: kinds,
      scope: z.string().trim().min(1).max(200).nullable(),
      mandatory: z.boolean(),
      reason: z.string().trim().min(5).max(500)
    }).strict().parse(req.body);
    const identity = validIdentityId(req.principal.identityId);
    if (!identity) return reply.code(403).send({ error: 'identified_admin_required' });
    const client = await pool.connect();
    try {
      await client.query('begin');
      const serviceCase = await client.query(
        'select id,state,selected_actor_id from service_cases where id=$1 for update',
        [params.caseId]
      );
      if (!serviceCase.rowCount) {
        await client.query('rollback');
        return reply.code(404).send({ error: 'case_not_found' });
      }
      await assertAdminCaseScope(req.principal,params.caseId,client);
      if (serviceCase.rows[0].selected_actor_id ||
          !['triage','diagnostic_pending','diagnostic_in_progress','provider_selection'].includes(serviceCase.rows[0].state)) {
        await client.query('rollback');
        return reply.code(409).send({ error: 'case_not_open_for_requirements' });
      }
      const previous = await client.query(
        'select * from case_qualification_requirements where service_case_id=$1 and requirement_key=$2',
        [params.caseId,params.requirementKey]
      );
      const result = await client.query(
        `insert into case_qualification_requirements(service_case_id,requirement_key,kind,scope,mandatory)
         values($1,$2,$3,$4,$5)
         on conflict(service_case_id,requirement_key)
         do update set kind=excluded.kind,scope=excluded.scope,mandatory=excluded.mandatory
         returning *`,
        [params.caseId,params.requirementKey,body.kind,body.scope,body.mandatory]
      );
      await client.query(
        `insert into audit_log(principal_role,principal_identity_id,action,object_type,object_id,metadata)
         values('admin',$1,'upsert_case_qualification','case_qualification_requirement',$2,$3)`,
        [identity,result.rows[0].id,JSON.stringify({
          caseId:params.caseId, before:previous.rows[0]??null, after:result.rows[0], reason:body.reason
        })]
      );
      // Invalidate the last eligibility snapshot without deleting historical decisions.
      // Previously recommended actors must not be presented as current after policy changes.
      const activeCase=await client.query('select demand_id from service_cases where id=$1',[params.caseId]);
      await client.query('update service_cases set recommended_actor_id=null,updated_at=now() where id=$1',[params.caseId]);
      const demandId=activeCase.rows[0]?.demand_id;
      if(demandId){
        await client.query(
          `insert into routing_decisions(demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,
              selected_actor_id,recommended_actor_id,selection_mode,decision_basis)
            select $1,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,null,null,coalesce(selection_mode,'customer_choice'),
              'qualification_requirements_changed:reroute_required'
            from service_cases where id=$2`,
          [demandId,params.caseId]
        );
      }
      await client.query('commit');
      return { requirement:result.rows[0], rerouteRequired:true };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  });

  app.get('/api/admin/qualifications/cases/:caseId/requirements', admin, async (req, reply) => {
    const { caseId } = z.object({ caseId:z.string().uuid() }).parse(req.params);
    await assertAdminCaseScope(req.principal,caseId,pool);
    const serviceCase = await pool.query('select id from service_cases where id=$1', [caseId]);
    if (!serviceCase.rowCount) return reply.code(404).send({ error:'case_not_found' });
    const requirements = await pool.query(
      'select * from case_qualification_requirements where service_case_id=$1 order by requirement_key',
      [caseId]
    );
    return { requirements:requirements.rows };
  });

  app.get('/api/admin/qualifications/cases/:caseId/recovery', admin, async (req) => {
    const {caseId}=z.object({caseId:z.string().uuid()}).parse(req.params);
    await assertAdminCaseScope(req.principal,caseId,pool);
    const found=await pool.query('select * from qualification_recovery_cases where case_id=$1 order by created_at desc',[caseId]);
    return {recoveries:found.rows};
  });

  app.post('/api/admin/qualifications/recovery/:id/resolve', admin, async (req,reply) => {
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({
      type:z.enum(['verified_alternative','provider_reassigned','case_cancelled']),
      note:z.string().trim().min(10).max(1500),
      evidenceReference:z.string().trim().min(3).max(500)
    }).strict().parse(req.body);
    const identity=validIdentityId(req.principal.identityId);
    if(!identity)return reply.code(403).send({error:'identified_admin_required'});
    const client=await pool.connect();
    try {
      await client.query('begin');
      const found=await client.query('select * from qualification_recovery_cases where id=$1 for update',[id]);
      if(!found.rowCount){await client.query('rollback');return reply.code(404).send({error:'recovery_not_found'});}
      const item=found.rows[0];
      await assertAdminCaseScope(req.principal,item.case_id,client);
      if(item.state!=='open'){await client.query('rollback');return reply.code(409).send({error:'recovery_already_closed'});}
      const caseResult=await client.query('select state,selected_actor_id from service_cases where id=$1 for update',[item.case_id]);
      const sc=caseResult.rows[0];
      if(!sc){await client.query('rollback');return reply.code(404).send({error:'case_not_found'});}
      if(body.type==='verified_alternative'){
        const decision=await loadActorQualifications(item.case_id,item.actor_id,client,new Date());
        if(decision.decision!=='eligible'){await client.query('rollback');return reply.code(409).send({error:'qualifications_not_satisfied'});}
      }
      if(body.type==='provider_reassigned'&&(!sc.selected_actor_id||sc.selected_actor_id===item.actor_id)){
        await client.query('rollback');return reply.code(409).send({error:'reassignment_not_verified'});
      }
      if(body.type==='case_cancelled'&&sc.state!=='cancelled'){
        await client.query('rollback');return reply.code(409).send({error:'cancellation_not_verified'});
      }
      const updated=await client.query(
        `update qualification_recovery_cases set state='resolved',resolution_type=$2,resolution_note=$3,evidence_reference=$4,
           resolved_by_identity_id=$5,resolved_at=now(),updated_at=now() where id=$1 returning *`,
        [id,body.type,body.note,body.evidenceReference,identity]
      );
      await client.query(
        `insert into audit_log(principal_role,principal_identity_id,action,object_type,object_id,metadata)
           values('admin',$1,'resolve_qualification_recovery','qualification_recovery_case',$2,$3)`,
        [identity,id,JSON.stringify({caseId:item.case_id,resolutionType:body.type,evidenceReference:body.evidenceReference})]
      );
      await client.query('commit');
      return {recovery:updated.rows[0]};
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  });

}
