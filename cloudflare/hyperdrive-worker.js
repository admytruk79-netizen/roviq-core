import { timingSafeEqual } from 'node:crypto';
import { Client } from 'pg';

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const MAX_PROMPT_CHARS = 8000;

const CORE_SYSTEM_PROMPT = `You are the ROVIQ Core intelligence layer for automotive service coordination.
ROVIQ coordinates vehicle-service workflows across drivers, dealerships, diagnostics, service providers, tow/vehicle transport, and mobility.
You assist with structured triage and coordination; you are not a replacement for a qualified technician and must not claim certainty about a mechanical diagnosis without evidence.
Prioritize safety. If the supplied facts indicate an immediate safety risk, advise that the vehicle should not be driven and should be assessed or transported appropriately.
Do not invent vehicle facts, diagnostic codes, availability, prices, partner commitments, or completed actions.
Keep responses concise, operational, and explicit about uncertainty.`;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('content_type_must_be_application_json');
  }
  return await request.json();
}

function requireInternalAuth(request, env) {
  const secret = env.ROVIQ_E2E_TOKEN;
  if (!secret) throw new Error('internal_auth_not_configured');
  const auth = request.headers.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(String(secret));
  const b = Buffer.from(String(supplied));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('unauthorized');
}

async function withClient(env, fn) {
  if (!env.HYPERDRIVE?.connectionString) throw new Error('hyperdrive_binding_missing');
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function query(env, text, values = []) {
  return await withClient(env, (client) => client.query(text, values));
}

async function transaction(env, fn) {
  return await withClient(env, async (client) => {
    await client.query('begin');
    try {
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

async function runAI(env, prompt, context = null) {
  if (!env.AI?.run) throw new Error('workers_ai_binding_missing');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt_required');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('prompt_too_large');

  const messages = [
    { role: 'system', content: CORE_SYSTEM_PROMPT },
    ...(context == null ? [] : [{ role: 'system', content: `ROVIQ context supplied by the application:\n${JSON.stringify(context)}` }]),
    { role: 'user', content: prompt.trim() }
  ];

  return await env.AI.run(AI_MODEL, { messages });
}

function aiText(result) {
  if (typeof result?.response === 'string') return result.response;
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

async function createCase(env, body = {}) {
  return await transaction(env, async (client) => {
    const domain = await client.query(`select id from domains where code='maintenance' limit 1`);
    if (!domain.rowCount) throw new Error('maintenance_domain_missing');
    const created = await client.query(
      `insert into service_cases(domain_id,priority,drivability,attributes)
       values($1,$2,$3,$4::jsonb) returning *`,
      [domain.rows[0].id, body.priority || 'normal', body.drivability || 'unknown', JSON.stringify(body.attributes || {})]
    );
    const serviceCase = created.rows[0];
    const plan = await client.query(
      `insert into service_plans(case_id,status,current_revision,customer_summary)
       values($1,'draft',1,$2) returning *`,
      [serviceCase.id, 'We are reviewing your vehicle concern and building the coordinated service plan.']
    );
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot)
       values($1,1,'Case opened',$2,$3::jsonb)`,
      [plan.rows[0].id, plan.rows[0].customer_summary, JSON.stringify({ state: 'draft', tasks: [] })]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'CASE_CREATED',$2::jsonb),
             ('service_case',$1,'SERVICE_PLAN_CREATED',$3::jsonb)`,
      [serviceCase.id, JSON.stringify({ state: serviceCase.state, priority: serviceCase.priority }), JSON.stringify({ servicePlanId: plan.rows[0].id, revision: 1 })]
    );
    return { case: serviceCase, servicePlan: plan.rows[0] };
  });
}

async function triageCase(env, caseId, body = {}) {
  const caseResult = await query(env, `select * from service_cases where id=$1`, [caseId]);
  if (!caseResult.rowCount) throw new Error('case_not_found');
  const serviceCase = caseResult.rows[0];
  const concern = String(body.concern || serviceCase.attributes?.concern || 'Vehicle service concern requires triage.');
  const ai = await runAI(env,
    `Triage this vehicle-service concern. Return concise operational guidance, identify whether it is safe to drive, and state the next coordination step. Concern: ${concern}`,
    { drivability: body.drivability || serviceCase.drivability, attributes: serviceCase.attributes }
  );
  const guidance = aiText(ai).slice(0, 4000);
  const nonDrivable = (body.drivability || serviceCase.drivability) === 'non_drivable';
  const nextState = nonDrivable ? 'tow_pending' : 'provider_selection';

  return await transaction(env, async (client) => {
    await client.query(`update service_cases set state='triage',updated_at=now(),version=version+1 where id=$1`, [caseId]);
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'CASE_TRIAGE',$2::jsonb)`,
      [caseId, JSON.stringify({ concern, guidance, model: AI_MODEL })]
    );
    const plan = await client.query(`select * from service_plans where case_id=$1 for update`, [caseId]);
    if (!plan.rowCount) throw new Error('service_plan_not_found');
    const revision = Number(plan.rows[0].current_revision) + 1;
    const tasks = nonDrivable
      ? [{ taskType: 'transport', title: 'Coordinate safe vehicle transport' }, { taskType: 'provider', title: 'Coordinate diagnostic/service provider' }]
      : [{ taskType: 'provider', title: 'Coordinate diagnostic/service provider' }];
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot)
       values($1,$2,'AI-assisted triage completed',$3,$4::jsonb)`,
      [plan.rows[0].id, revision, guidance, JSON.stringify({ triage: guidance, nextState, tasks })]
    );
    for (const [index, task] of tasks.entries()) {
      await client.query(
        `insert into service_plan_tasks(service_plan_id,revision,task_type,sequence,title,metadata)
         values($1,$2,$3,$4,$5,$6::jsonb)`,
        [plan.rows[0].id, revision, task.taskType, index, task.title, JSON.stringify({ source: 'triage' })]
      );
    }
    await client.query(
      `update service_plans set current_revision=$1,status='proposed',customer_summary=$2,updated_at=now() where id=$3`,
      [revision, guidance, plan.rows[0].id]
    );
    const updated = await client.query(
      `update service_cases set state=$1,drivability=$2,updated_at=now(),version=version+1 where id=$3 returning *`,
      [nextState, body.drivability || serviceCase.drivability, caseId]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,$2,$3::jsonb)`,
      [caseId, `CASE_${nextState.toUpperCase()}`, JSON.stringify({ from: 'triage', to: nextState })]
    );
    return { case: updated.rows[0], triage: { guidance, model: AI_MODEL }, servicePlanRevision: revision };
  });
}

async function routeCase(env, caseId) {
  return await transaction(env, async (client) => {
    const current = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!current.rowCount) throw new Error('case_not_found');
    let state = current.rows[0].state;
    if (state === 'tow_pending') {
      await client.query(`update service_cases set state='tow_in_progress',updated_at=now(),version=version+1 where id=$1`, [caseId]);
      await client.query(`insert into events(aggregate_type,aggregate_id,event_type,payload) values('service_case',$1,'CASE_TOW_IN_PROGRESS',$2::jsonb)`, [caseId, JSON.stringify({ automatedTestFlow: true })]);
      state = 'tow_in_progress';
    }
    if (state === 'tow_in_progress') {
      await client.query(`update service_cases set state='provider_selection',updated_at=now(),version=version+1 where id=$1`, [caseId]);
      state = 'provider_selection';
    }
    if (state !== 'provider_selection') throw new Error('case_not_ready_for_routing');

    const provider = await client.query(
      `select id,actor_type from actors
       where status='active' and actor_type in ('partner','service_provider','dealership','diagnostic')
       order by case actor_type when 'service_provider' then 0 when 'dealership' then 1 when 'diagnostic' then 2 else 3 end,created_at asc limit 1`
    );
    const providerActorId = provider.rows[0]?.id || null;
    const plan = await client.query(`select id,current_revision from service_plans where case_id=$1`, [caseId]);
    const commitment = await client.query(
      `insert into case_commitments(case_id,service_plan_id,commitment_type,provider_actor_id,state,terms)
       values($1,$2,'service_provider',$3,'proposed',$4::jsonb) returning *`,
      [caseId, plan.rows[0]?.id || null, providerActorId, JSON.stringify({ selectedBy: 'roviq-core-routing', providerFound: Boolean(providerActorId) })]
    );
    const updated = await client.query(
      `update service_cases set state='provider_pending',current_owner_actor_id=$1,current_owner_role=$2,updated_at=now(),version=version+1 where id=$3 returning *`,
      [providerActorId, provider.rows[0]?.actor_type || null, caseId]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'ROUTING_COMPLETED',$2::jsonb),('service_case',$1,'CASE_PROVIDER_PENDING',$3::jsonb)`,
      [caseId, JSON.stringify({ providerActorId, providerType: provider.rows[0]?.actor_type || null }), JSON.stringify({ from: 'provider_selection', to: 'provider_pending' })]
    );
    return { case: updated.rows[0], routing: { providerActorId, providerType: provider.rows[0]?.actor_type || null, commitment: commitment.rows[0] } };
  });
}

async function approveCase(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const plan = await client.query(`select * from service_plans where case_id=$1 for update`, [caseId]);
    if (!plan.rowCount) throw new Error('service_plan_not_found');
    const approval = await client.query(
      `insert into case_approvals(case_id,service_plan_id,revision,approval_type,state,decision_reason,amount_minor,currency,decided_at)
       values($1,$2,$3,'service_plan','approved',$4,$5,$6,now()) returning *`,
      [caseId, plan.rows[0].id, plan.rows[0].current_revision, body.reason || 'Approved for coordinated service', body.amountMinor ?? plan.rows[0].estimated_total_minor, body.currency || plan.rows[0].currency || 'USD']
    );
    const updatedPlan = await client.query(
      `update service_plans set status='approved',approved_total_minor=coalesce($1,estimated_total_minor),approved_at=now(),updated_at=now() where id=$2 returning *`,
      [body.amountMinor ?? plan.rows[0].estimated_total_minor, plan.rows[0].id]
    );
    await client.query(`insert into events(aggregate_type,aggregate_id,event_type,payload) values('service_case',$1,'SERVICE_PLAN_APPROVED',$2::jsonb)`, [caseId, JSON.stringify({ revision: plan.rows[0].current_revision, approvalId: approval.rows[0].id })]);
    return { approval: approval.rows[0], servicePlan: updatedPlan.rows[0] };
  });
}

async function completeCase(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const current = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!current.rowCount) throw new Error('case_not_found');
    const sequence = [];
    let state = current.rows[0].state;
    if (state === 'provider_pending') sequence.push('repair_in_progress');
    if (state === 'provider_pending' || state === 'repair_in_progress') sequence.push('payment_pending');
    sequence.push('completed');
    for (const nextState of sequence) {
      await client.query(
        `update service_cases set state=$1,updated_at=now(),version=version+1,completed_at=case when $1='completed' then now() else completed_at end where id=$2`,
        [nextState, caseId]
      );
      await client.query(
        `insert into events(aggregate_type,aggregate_id,event_type,payload) values('service_case',$1,$2,$3::jsonb)`,
        [caseId, `CASE_${nextState.toUpperCase()}`, JSON.stringify({ outcome: body.outcome || 'completed', note: body.note || null })]
      );
      state = nextState;
    }
    await client.query(`update service_plans set status='completed',updated_at=now() where case_id=$1`, [caseId]);
    const finalCase = await client.query(`select * from service_cases where id=$1`, [caseId]);
    return { case: finalCase.rows[0], outcome: { state, outcome: body.outcome || 'completed' } };
  });
}

async function getServicePlan(env, caseId) {
  return await transaction(env, async (client) => {
    const plan = await client.query(`select * from service_plans where case_id=$1`, [caseId]);
    if (!plan.rowCount) throw new Error('service_plan_not_found');
    const id = plan.rows[0].id;
    const [revisions, tasks, commitments, approvals] = await Promise.all([
      client.query(`select * from service_plan_revisions where service_plan_id=$1 order by revision desc`, [id]),
      client.query(`select * from service_plan_tasks where service_plan_id=$1 order by revision desc,sequence asc,created_at asc`, [id]),
      client.query(`select * from case_commitments where service_plan_id=$1 order by created_at desc`, [id]),
      client.query(`select * from case_approvals where service_plan_id=$1 order by created_at desc`, [id])
    ]);
    return { plan: plan.rows[0], revisions: revisions.rows, tasks: tasks.rows, commitments: commitments.rows, approvals: approvals.rows };
  });
}

async function runE2E(env) {
  const created = await createCase(env, { priority: 'urgent', drivability: 'non_drivable', attributes: { concern: 'Vehicle will not start; dashboard warning present.', source: 'automated_e2e' } });
  const caseId = created.case.id;
  const triage = await triageCase(env, caseId, { concern: 'Vehicle will not start; dashboard warning present.', drivability: 'non_drivable' });
  const routing = await routeCase(env, caseId);
  const approval = await approveCase(env, caseId, { reason: 'Automated end-to-end approval' });
  const outcome = await completeCase(env, caseId, { outcome: 'completed', note: 'Automated live business-flow verification' });
  const plan = await getServicePlan(env, caseId);
  const events = await query(env, `select event_type,occurred_at,payload from events where aggregate_type='service_case' and aggregate_id=$1 order by occurred_at asc`, [caseId]);
  return { ok: true, caseId, created, triage, routing, approval, outcome, servicePlan: plan, events: events.rows };
}

function errorResponse(error) {
  const message = String(error?.message || error);
  if (message === 'unauthorized') return reply({ ok: false, error: message }, 401);
  if (['content_type_must_be_application_json', 'prompt_required', 'prompt_too_large'].includes(message)) return reply({ ok: false, error: message }, 400);
  if (['case_not_found', 'service_plan_not_found'].includes(message)) return reply({ ok: false, error: message }, 404);
  if (message === 'case_not_ready_for_routing') return reply({ ok: false, error: message }, 409);
  return reply({ ok: false, error: message }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return reply({ ok: true, service: 'roviq-core', runtime: 'cloudflare-worker', databaseTransport: 'hyperdrive-neon', aiBinding: Boolean(env.AI), aiModel: AI_MODEL, businessFlow: 'service-case-v1' });
    }

    if (url.pathname === '/ready') {
      try {
        const result = await query(env, `select now() as database_time,current_database() as database_name,current_user as database_user,(select count(*)::int from schema_migrations) as migration_count`);
        return reply({ ok: true, service: 'roviq-core', database: 'reachable', databaseTransport: 'hyperdrive-neon', aiBinding: Boolean(env.AI), ...result.rows[0] });
      } catch (error) { return errorResponse(error); }
    }

    if (url.pathname === '/api/core/status') {
      try {
        const result = await query(env, `select (select count(*)::int from actors) as actors,(select count(*)::int from domains) as domains,(select count(*)::int from service_cases) as service_cases,(select count(*)::int from demand_requests) as demand_requests`);
        return reply({ ok: true, counts: result.rows[0] });
      } catch (error) { return errorResponse(error); }
    }

    if (url.pathname === '/api/ai/ping') {
      if (request.method !== 'GET') return reply({ ok: false, error: 'method_not_allowed' }, 405);
      try {
        const result = await runAI(env, 'Reply with exactly: ROVIQ_AI_OK');
        return reply({ ok: true, workersAI: 'inference_ok', model: AI_MODEL, result });
      } catch (error) { return errorResponse(error); }
    }

    if (url.pathname === '/api/ai/respond') {
      if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405);
      try {
        const body = await readJson(request);
        const result = await runAI(env, body?.prompt, body?.context ?? null);
        return reply({ ok: true, engine: 'roviq-core-ai', model: AI_MODEL, result });
      } catch (error) { return errorResponse(error); }
    }

    const casePlanMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/service-plan$/i);
    const triageMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/triage$/i);
    const routingMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/routing$/i);
    const approvalMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/approvals$/i);
    const outcomeMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/outcome$/i);

    try {
      if (url.pathname === '/api/maintenance/cases' && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await createCase(env, await readJson(request)), 201);
      }
      if (casePlanMatch && request.method === 'GET') {
        requireInternalAuth(request, env);
        return reply(await getServicePlan(env, casePlanMatch[1]));
      }
      if (triageMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await triageCase(env, triageMatch[1], await readJson(request)));
      }
      if (routingMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await routeCase(env, routingMatch[1]));
      }
      if (approvalMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await approveCase(env, approvalMatch[1], await readJson(request)));
      }
      if (outcomeMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await completeCase(env, outcomeMatch[1], await readJson(request)));
      }
      if (url.pathname === '/api/internal/e2e/service-case' && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await runE2E(env), 201);
      }
    } catch (error) { return errorResponse(error); }

    return reply({ error: 'not_found' }, 404);
  }
};
