import { timingSafeEqual } from 'node:crypto';
import { Client } from 'pg';

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const MAX_PROMPT_CHARS = 8000;

const CORE_SYSTEM_PROMPT = `You are the ROVIQ Core intelligence layer for automotive service coordination.
ROVIQ coordinates vehicle-service workflows across drivers, dealerships, diagnostics, service providers, tow/vehicle transport, mobility, parts, and payments.
You assist with structured triage and coordination; you are not a replacement for a qualified technician and must not claim certainty about a mechanical diagnosis without evidence.
Prioritize safety. If the supplied facts indicate an immediate safety risk, advise that the vehicle should not be driven and should be assessed or transported appropriately.
Do not invent vehicle facts, diagnostic codes, availability, prices, partner commitments, completed actions, or database state.
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
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('content_type_must_be_application_json');
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
  try { return await fn(client); }
  finally { await client.end().catch(() => undefined); }
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

async function appendEvent(client, caseId, eventType, payload = {}, actorId = null) {
  const result = await client.query(
    `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
     values('service_case',$1,$2,$3,$4::jsonb) returning *`,
    [caseId, eventType, actorId, JSON.stringify(payload)]
  );
  return result.rows[0];
}

async function transitionCase(client, caseId, toState, role = 'admin', payload = {}) {
  const current = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
  if (!current.rowCount) throw new Error('case_not_found');
  const fromState = current.rows[0].state;
  if (fromState === toState) return current.rows[0];

  const rule = await client.query(
    `select * from case_transition_rules where from_state=$1 and to_state=$2`,
    [fromState, toState]
  );
  if (!rule.rowCount) throw new Error(`invalid_case_transition:${fromState}:${toState}`);
  if (!rule.rows[0].allowed_roles.includes(role)) throw new Error(`transition_role_not_allowed:${role}`);

  const updated = await client.query(
    `update service_cases
       set state=$1,version=version+1,updated_at=now(),completed_at=case when $1='completed' then now() else completed_at end
     where id=$2 returning *`,
    [toState, caseId]
  );
  await appendEvent(client, caseId, `CASE_${toState.toUpperCase()}`, { from: fromState, to: toState, ...payload });
  return updated.rows[0];
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

async function resolveMaintenanceDomain(client) {
  const domain = await client.query(`select id from domains where code='maintenance' and status='active' limit 1`);
  if (!domain.rowCount) throw new Error('maintenance_domain_missing');
  return domain.rows[0].id;
}

async function createVehicleIfNeeded(client, body, requesterActorId) {
  if (body.vehicleId) return body.vehicleId;
  if (!body.vehicle) return null;
  const v = body.vehicle;
  if (v.vin) {
    const existing = await client.query(`select id from vehicles where upper(vin)=upper($1) limit 1`, [v.vin]);
    if (existing.rowCount) return existing.rows[0].id;
  }
  const created = await client.query(
    `insert into vehicles(owner_actor_id,vin,year,make,model,trim,powertrain,odometer_value,odometer_unit,attributes)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) returning id`,
    [requesterActorId || null, v.vin || null, v.year || null, v.make || null, v.model || null, v.trim || null, v.powertrain || null,
     v.odometerValue ?? null, v.odometerUnit || 'miles', JSON.stringify(v.attributes || {})]
  );
  return created.rows[0].id;
}

async function createDemand(env, body = {}) {
  return await transaction(env, async (client) => {
    const domainId = await resolveMaintenanceDomain(client);
    const demand = await client.query(
      `insert into demand_requests(domain_id,requester_actor_id,demand_type,location,urgency,attributes,state)
       values($1,$2,$3,$4::jsonb,$5,$6::jsonb,'open') returning *`,
      [domainId, body.requesterActorId || null, body.demandType || 'maintenance', JSON.stringify(body.location || {}),
       body.urgency || 'normal', JSON.stringify(body.attributes || {})]
    );
    return { demand: demand.rows[0] };
  });
}

async function createCase(env, body = {}) {
  return await transaction(env, async (client) => {
    const domainId = await resolveMaintenanceDomain(client);
    const requesterActorId = body.requesterActorId || body.customerActorId || null;
    const attributes = { ...(body.attributes || {}) };
    if (body.concern && !attributes.concern) attributes.concern = body.concern;
    const vehicleId = await createVehicleIfNeeded(client, body, requesterActorId);

    let demand;
    if (body.demandId) {
      const existing = await client.query(`select * from demand_requests where id=$1 for update`, [body.demandId]);
      if (!existing.rowCount) throw new Error('demand_not_found');
      demand = existing.rows[0];
    } else {
      const createdDemand = await client.query(
        `insert into demand_requests(domain_id,requester_actor_id,demand_type,location,urgency,attributes,state)
         values($1,$2,$3,$4::jsonb,$5,$6::jsonb,'open') returning *`,
        [domainId, requesterActorId, body.demandType || 'maintenance', JSON.stringify(body.location || {}), body.urgency || body.priority || 'normal', JSON.stringify(attributes)]
      );
      demand = createdDemand.rows[0];
    }

    const created = await client.query(
      `insert into service_cases(domain_id,demand_id,customer_actor_id,vehicle_id,priority,drivability,attributes)
       values($1,$2,$3,$4,$5,$6,$7::jsonb) returning *`,
      [domainId, demand.id, body.customerActorId || requesterActorId, vehicleId, body.priority || demand.urgency || 'normal', body.drivability || 'unknown', JSON.stringify(attributes)]
    );
    const serviceCase = created.rows[0];
    const summary = body.customerSummary || 'We are reviewing your vehicle concern and building the coordinated service plan.';
    const plan = await client.query(
      `insert into service_plans(case_id,status,current_revision,customer_summary,created_by_actor_id)
       values($1,'draft',1,$2,$3) returning *`,
      [serviceCase.id, summary, requesterActorId]
    );
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot,created_by_actor_id)
       values($1,1,'Case opened',$2,$3::jsonb,$4)`,
      [plan.rows[0].id, summary, JSON.stringify({ state: 'draft', demandId: demand.id, vehicleId, tasks: [] }), requesterActorId]
    );
    await appendEvent(client, serviceCase.id, 'DEMAND_LINKED', { demandId: demand.id });
    await appendEvent(client, serviceCase.id, 'CASE_CREATED', { state: serviceCase.state, priority: serviceCase.priority, vehicleId });
    await appendEvent(client, serviceCase.id, 'SERVICE_PLAN_CREATED', { servicePlanId: plan.rows[0].id, revision: 1 });
    return { demand, case: serviceCase, servicePlan: plan.rows[0] };
  });
}

async function getCase(env, caseId) {
  return await withClient(env, async (client) => {
    const serviceCase = await client.query(`select * from service_cases where id=$1`, [caseId]);
    if (!serviceCase.rowCount) throw new Error('case_not_found');
    const c = serviceCase.rows[0];
    const [demand, vehicle, plan, transports, findings, events] = await Promise.all([
      c.demand_id ? client.query(`select * from demand_requests where id=$1`, [c.demand_id]) : Promise.resolve({ rows: [] }),
      c.vehicle_id ? client.query(`select * from vehicles where id=$1`, [c.vehicle_id]) : Promise.resolve({ rows: [] }),
      client.query(`select * from service_plans where case_id=$1`, [caseId]),
      client.query(`select * from transport_dispatches where case_id=$1 order by created_at desc`, [caseId]),
      client.query(`select * from diagnostic_findings where case_id=$1 order by created_at desc`, [caseId]),
      client.query(`select event_type,actor_id,occurred_at,payload,correlation_id from events where aggregate_type='service_case' and aggregate_id=$1 order by occurred_at asc`, [caseId])
    ]);
    return { case: c, demand: demand.rows[0] || null, vehicle: vehicle.rows[0] || null, servicePlan: plan.rows[0] || null, transports: transports.rows, diagnostics: findings.rows, events: events.rows };
  });
}

async function reviseServicePlan(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const planResult = await client.query(`select * from service_plans where case_id=$1 for update`, [caseId]);
    if (!planResult.rowCount) throw new Error('service_plan_not_found');
    const plan = planResult.rows[0];
    const revision = Number(plan.current_revision) + 1;
    const reason = String(body.changeReason || '').trim();
    if (!reason) throw new Error('change_reason_required');
    const summary = body.customerSummary ?? plan.customer_summary;

    let tasks = Array.isArray(body.tasks) ? body.tasks : null;
    if (!tasks) {
      const currentTasks = await client.query(`select * from service_plan_tasks where service_plan_id=$1 and revision=$2 order by sequence,created_at`, [plan.id, plan.current_revision]);
      tasks = currentTasks.rows.map((t) => ({
        taskType: t.task_type, sequence: t.sequence, status: t.status, assignedActorId: t.assigned_actor_id,
        title: t.title, instructions: t.instructions, dueAt: t.due_at, estimatedAmountMinor: t.estimated_amount_minor,
        currency: t.currency, metadata: t.metadata
      }));
    }

    const snapshot = body.planSnapshot || { tasks, sourceRevision: plan.current_revision };
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot,estimated_total_minor,currency,created_by_actor_id)
       values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [plan.id, revision, reason, summary, JSON.stringify(snapshot), body.estimatedTotalMinor ?? plan.estimated_total_minor, body.currency || plan.currency, body.createdByActorId || null]
    );
    for (const [index, task] of tasks.entries()) {
      await client.query(
        `insert into service_plan_tasks(service_plan_id,revision,task_type,sequence,status,assigned_actor_id,title,instructions,due_at,estimated_amount_minor,currency,metadata)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [plan.id, revision, task.taskType || task.type || 'service', task.sequence ?? index, task.status || 'pending', task.assignedActorId || null,
         task.title || 'Service task', task.instructions || null, task.dueAt || null, task.estimatedAmountMinor ?? null, task.currency || plan.currency || 'USD', JSON.stringify(task.metadata || {})]
      );
    }
    const updated = await client.query(
      `update service_plans set current_revision=$1,status='proposed',customer_summary=$2,estimated_total_minor=$3,currency=$4,updated_at=now() where id=$5 returning *`,
      [revision, summary, body.estimatedTotalMinor ?? plan.estimated_total_minor, body.currency || plan.currency, plan.id]
    );
    await appendEvent(client, caseId, 'SERVICE_PLAN_REVISED', { servicePlanId: plan.id, revision, changeReason: reason, material: body.material !== false });
    return { servicePlan: updated.rows[0], revision };
  });
}

async function triageCase(env, caseId, body = {}) {
  const caseResult = await query(env, `select * from service_cases where id=$1`, [caseId]);
  if (!caseResult.rowCount) throw new Error('case_not_found');
  const serviceCase = caseResult.rows[0];
  if (serviceCase.state !== 'intake') throw new Error(`triage_requires_intake:${serviceCase.state}`);
  const concern = String(body.concern || serviceCase.attributes?.concern || 'Vehicle service concern requires triage.');
  const drivability = body.drivability || serviceCase.drivability || 'unknown';
  const ai = await runAI(env,
    `Triage this vehicle-service concern. Return concise operational guidance, identify whether it is safe to drive, and state the next coordination step. Concern: ${concern}`,
    { drivability, vehicleId: serviceCase.vehicle_id, attributes: serviceCase.attributes }
  );
  const guidance = aiText(ai).slice(0, 4000);
  const nonDrivable = drivability === 'non_drivable';
  const nextState = nonDrivable ? 'tow_pending' : 'provider_selection';

  return await transaction(env, async (client) => {
    await transitionCase(client, caseId, 'triage', 'admin', { source: 'workers_ai', model: AI_MODEL });
    await appendEvent(client, caseId, 'CASE_TRIAGE', { concern, guidance, model: AI_MODEL, drivability });
    const planResult = await client.query(`select * from service_plans where case_id=$1 for update`, [caseId]);
    if (!planResult.rowCount) throw new Error('service_plan_not_found');
    const plan = planResult.rows[0];
    const revision = Number(plan.current_revision) + 1;
    const tasks = nonDrivable
      ? [{ taskType: 'transport', title: 'Coordinate safe vehicle transport' }, { taskType: 'diagnostic', title: 'Coordinate diagnostics/service provider' }]
      : [{ taskType: 'diagnostic', title: 'Coordinate diagnostics/service provider' }];
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot)
       values($1,$2,'AI-assisted triage completed',$3,$4::jsonb)`,
      [plan.id, revision, guidance, JSON.stringify({ triage: guidance, nextState, tasks })]
    );
    for (const [index, task] of tasks.entries()) {
      await client.query(
        `insert into service_plan_tasks(service_plan_id,revision,task_type,sequence,title,metadata)
         values($1,$2,$3,$4,$5,$6::jsonb)`,
        [plan.id, revision, task.taskType, index, task.title, JSON.stringify({ source: 'workers_ai_triage' })]
      );
    }
    await client.query(`update service_plans set current_revision=$1,status='proposed',customer_summary=$2,updated_at=now() where id=$3`, [revision, guidance, plan.id]);
    await client.query(`update service_cases set drivability=$1,updated_at=now() where id=$2`, [drivability, caseId]);
    const updatedCase = await transitionCase(client, caseId, nextState, 'admin', { reason: nonDrivable ? 'transport_required' : 'provider_selection_required' });
    return { case: updatedCase, triage: { concern, guidance, drivability, model: AI_MODEL }, servicePlanRevision: revision };
  });
}

async function routeCase(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const current = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!current.rowCount) throw new Error('case_not_found');
    if (current.rows[0].state !== 'provider_selection') throw new Error(`case_not_ready_for_routing:${current.rows[0].state}`);
    if (!current.rows[0].demand_id) throw new Error('case_demand_missing');

    const capability = body.capability || 'repair';
    const candidates = await client.query(
      `select distinct a.id,a.actor_type,
              coalesce(pc.routing_enabled,true) as routing_enabled,
              pc.earliest_available_at,
              pc.service_radius_miles,
              pc.max_active_jobs
         from actors a
         join actor_capabilities ac on ac.actor_id=a.id and ac.active=true
         join capabilities c on c.id=ac.capability_id and c.capability_code=$1
         left join partner_controls pc on pc.actor_id=a.id
        where a.status='active' and coalesce(pc.routing_enabled,true)=true
        order by pc.earliest_available_at asc nulls last,a.created_at asc
        limit 25`,
      [capability]
    );
    const selected = candidates.rows[0] || null;
    const decision = await client.query(
      `insert into routing_decisions(demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,selected_actor_id,decision_basis)
       values($1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5) returning *`,
      [current.rows[0].demand_id, JSON.stringify(candidates.rows.map((x) => x.id)),
       JSON.stringify(candidates.rows.map((x, i) => ({ actorId: x.id, rank: i + 1, actorType: x.actor_type, earliestAvailableAt: x.earliest_available_at }))),
       selected?.id || null, selected ? `capability:${capability};routing_enabled:true` : `capability:${capability};no_eligible_provider`]
    );
    const plan = await client.query(`select id,current_revision from service_plans where case_id=$1`, [caseId]);
    const commitment = await client.query(
      `insert into case_commitments(case_id,service_plan_id,commitment_type,provider_actor_id,state,terms)
       values($1,$2,$3,$4,'proposed',$5::jsonb) returning *`,
      [caseId, plan.rows[0]?.id || null, capability, selected?.id || null,
       JSON.stringify({ selectedBy: 'roviq-core-routing-v2', routingDecisionId: decision.rows[0].id, providerFound: Boolean(selected) })]
    );
    const updated = await transitionCase(client, caseId, 'provider_pending', 'admin', { selectedActorId: selected?.id || null, capability });
    if (selected) {
      await client.query(`update service_cases set current_owner_actor_id=$1,current_owner_role=$2,updated_at=now() where id=$3`, [selected.id, selected.actor_type, caseId]);
    }
    await appendEvent(client, caseId, 'ROUTING_COMPLETED', { routingDecisionId: decision.rows[0].id, providerActorId: selected?.id || null, capability, candidateCount: candidates.rowCount });
    return { case: { ...updated, current_owner_actor_id: selected?.id || null, current_owner_role: selected?.actor_type || null }, routing: { decision: decision.rows[0], selectedProvider: selected, commitment: commitment.rows[0] } };
  });
}

async function createTransport(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const current = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!current.rowCount) throw new Error('case_not_found');
    if (current.rows[0].state !== 'tow_pending') throw new Error(`transport_requires_tow_pending:${current.rows[0].state}`);
    const dispatch = await client.query(
      `insert into transport_dispatches(case_id,transport_type,provider_actor_id,status,pickup_location,dropoff_location,vehicle_context,eta_at,external_reference,metadata)
       values($1,$2,$3,'requested',$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb) returning *`,
      [caseId, body.transportType || 'tow', body.providerActorId || null, JSON.stringify(body.pickupLocation || {}), JSON.stringify(body.dropoffLocation || {}),
       JSON.stringify(body.vehicleContext || {}), body.etaAt || null, body.externalReference || null, JSON.stringify(body.metadata || {})]
    );
    const updated = await transitionCase(client, caseId, 'tow_in_progress', 'admin', { transportDispatchId: dispatch.rows[0].id });
    await appendEvent(client, caseId, 'TRANSPORT_REQUESTED', { transportDispatchId: dispatch.rows[0].id, transportType: dispatch.rows[0].transport_type });
    return { case: updated, transport: dispatch.rows[0] };
  });
}

async function updateTransport(env, caseId, dispatchId, body = {}) {
  const allowed = new Set(['requested','assigned','accepted','en_route','arrived','vehicle_loaded','in_transit','delivered','declined','cancelled','failed']);
  if (!allowed.has(body.status)) throw new Error('invalid_transport_status');
  return await transaction(env, async (client) => {
    const dispatch = await client.query(`select * from transport_dispatches where id=$1 and case_id=$2 for update`, [dispatchId, caseId]);
    if (!dispatch.rowCount) throw new Error('transport_not_found');
    const updatedDispatch = await client.query(
      `update transport_dispatches set status=$1,provider_actor_id=coalesce($2,provider_actor_id),eta_at=coalesce($3,eta_at),metadata=metadata || $4::jsonb,
        assigned_at=case when $1='assigned' then now() else assigned_at end,
        accepted_at=case when $1='accepted' then now() else accepted_at end,
        en_route_at=case when $1='en_route' then now() else en_route_at end,
        arrived_at=case when $1='arrived' then now() else arrived_at end,
        completed_at=case when $1='delivered' then now() else completed_at end,updated_at=now()
       where id=$5 returning *`,
      [body.status, body.providerActorId || null, body.etaAt || null, JSON.stringify(body.metadata || {}), dispatchId]
    );
    await appendEvent(client, caseId, 'TRANSPORT_STATUS_CHANGED', { transportDispatchId: dispatchId, from: dispatch.rows[0].status, to: body.status });
    let serviceCase = (await client.query(`select * from service_cases where id=$1`, [caseId])).rows[0];
    if (body.status === 'delivered') {
      const nextState = body.nextState || 'provider_selection';
      if (!['provider_selection','diagnostic_pending','repair_in_progress'].includes(nextState)) throw new Error('invalid_transport_next_state');
      serviceCase = await transitionCase(client, caseId, nextState, 'admin', { transportDispatchId: dispatchId, delivered: true });
    }
    return { case: serviceCase, transport: updatedDispatch.rows[0] };
  });
}

async function createDiagnosticFinding(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const currentResult = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!currentResult.rowCount) throw new Error('case_not_found');
    let current = currentResult.rows[0];
    if (!current.demand_id) throw new Error('case_demand_missing');
    if (!body.diagnosticActorId) throw new Error('diagnostic_actor_required');
    if (current.state === 'diagnostic_pending') current = await transitionCase(client, caseId, 'diagnostic_in_progress', 'diagnostic', { diagnosticActorId: body.diagnosticActorId });
    if (current.state !== 'diagnostic_in_progress') throw new Error(`diagnostic_requires_diagnostic_state:${current.state}`);

    const finding = await client.query(
      `insert into diagnostic_findings(demand_id,case_id,diagnostic_actor_id,finding_code,summary,drivability,disposition,confidence,details)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning *`,
      [current.demand_id, caseId, body.diagnosticActorId, body.findingCode || null, body.summary || 'Diagnostic finding recorded', body.drivability || 'unknown',
       body.disposition || 'route_to_shop', body.confidence ?? null, JSON.stringify(body.details || {})]
    );
    await client.query(`update service_cases set drivability=$1,updated_at=now() where id=$2`, [finding.rows[0].drivability, caseId]);
    await appendEvent(client, caseId, 'DIAGNOSTIC_FINDING_RECORDED', { findingId: finding.rows[0].id, disposition: finding.rows[0].disposition, drivability: finding.rows[0].drivability }, body.diagnosticActorId);

    const map = { route_to_shop: 'provider_selection', route_to_tow: 'tow_pending', diagnose_and_fix: 'repair_in_progress', diagnose_only: 'provider_selection' };
    const nextState = body.nextState || map[finding.rows[0].disposition];
    let updatedCase = (await client.query(`select * from service_cases where id=$1`, [caseId])).rows[0];
    if (nextState) updatedCase = await transitionCase(client, caseId, nextState, 'diagnostic', { findingId: finding.rows[0].id });
    return { case: updatedCase, diagnosticFinding: finding.rows[0] };
  });
}

async function createServiceOrder(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const current = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!current.rowCount) throw new Error('case_not_found');
    if (!['provider_pending','repair_in_progress','parts_pending'].includes(current.rows[0].state)) throw new Error(`service_order_not_allowed:${current.rows[0].state}`);
    const planResult = await client.query(`select * from service_plans where case_id=$1 for update`, [caseId]);
    if (!planResult.rowCount) throw new Error('service_plan_not_found');
    const plan = planResult.rows[0];
    if (plan.status !== 'approved' && body.allowUnapproved !== true) throw new Error('service_plan_not_approved');
    const task = await client.query(
      `insert into service_plan_tasks(service_plan_id,revision,task_type,sequence,status,assigned_actor_id,title,instructions,due_at,estimated_amount_minor,currency,metadata)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) returning *`,
      [plan.id, plan.current_revision, body.taskType || 'service', body.sequence ?? 100, body.status || (body.assignedActorId ? 'assigned' : 'ready'), body.assignedActorId || null,
       body.title || 'Repair/service order', body.instructions || null, body.dueAt || null, body.estimatedAmountMinor ?? null, body.currency || plan.currency || 'USD', JSON.stringify(body.metadata || {})]
    );
    let updatedCase = current.rows[0];
    if (current.rows[0].state === 'provider_pending' && body.start !== false) updatedCase = await transitionCase(client, caseId, 'repair_in_progress', 'admin', { serviceTaskId: task.rows[0].id });
    await client.query(`update service_plans set status='in_progress',updated_at=now() where id=$1`, [plan.id]);
    await appendEvent(client, caseId, 'SERVICE_ORDER_CREATED', { serviceTaskId: task.rows[0].id, assignedActorId: task.rows[0].assigned_actor_id });
    return { case: updatedCase, serviceOrder: task.rows[0] };
  });
}

async function approveCase(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    const planResult = await client.query(`select * from service_plans where case_id=$1 for update`, [caseId]);
    if (!planResult.rowCount) throw new Error('service_plan_not_found');
    const plan = planResult.rows[0];
    const approval = await client.query(
      `insert into case_approvals(case_id,service_plan_id,revision,approval_type,state,requested_from_actor_id,requested_by_actor_id,decision_by_actor_id,decision_reason,amount_minor,currency,decided_at)
       values($1,$2,$3,'service_plan','approved',$4,$5,$6,$7,$8,$9,now()) returning *`,
      [caseId, plan.id, plan.current_revision, body.requestedFromActorId || null, body.requestedByActorId || null, body.decisionByActorId || body.requestedFromActorId || null,
       body.reason || 'Approved for coordinated service', body.amountMinor ?? plan.estimated_total_minor, body.currency || plan.currency || 'USD']
    );
    const updatedPlan = await client.query(
      `update service_plans set status='approved',approved_total_minor=coalesce($1,estimated_total_minor),approved_by_actor_id=$2,approved_at=now(),updated_at=now() where id=$3 returning *`,
      [body.amountMinor ?? plan.estimated_total_minor, body.decisionByActorId || body.requestedFromActorId || null, plan.id]
    );
    await appendEvent(client, caseId, 'SERVICE_PLAN_APPROVED', { revision: plan.current_revision, approvalId: approval.rows[0].id, amountMinor: approval.rows[0].amount_minor });
    return { approval: approval.rows[0], servicePlan: updatedPlan.rows[0] };
  });
}

async function completeCase(env, caseId, body = {}) {
  return await transaction(env, async (client) => {
    let current = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!current.rowCount) throw new Error('case_not_found');
    let serviceCase = current.rows[0];
    if (serviceCase.state === 'provider_pending') serviceCase = await transitionCase(client, caseId, 'repair_in_progress', 'admin', { outcome: body.outcome || 'completed' });
    if (serviceCase.state === 'parts_pending') serviceCase = await transitionCase(client, caseId, 'repair_in_progress', 'admin', { partsResolved: true });
    if (serviceCase.state === 'repair_in_progress') serviceCase = await transitionCase(client, caseId, 'payment_pending', 'admin', { repairOutcome: body.outcome || 'completed' });
    if (serviceCase.state === 'payment_pending') {
      if (body.paymentSettled !== true) {
        await appendEvent(client, caseId, 'OUTCOME_RECORDED_PAYMENT_PENDING', { outcome: body.outcome || 'completed', note: body.note || null });
        return { case: serviceCase, outcome: { state: 'payment_pending', completed: false, paymentRequired: true } };
      }
      serviceCase = await transitionCase(client, caseId, 'completed', 'admin', { outcome: body.outcome || 'completed', note: body.note || null });
      await client.query(`update service_plans set status='completed',updated_at=now() where case_id=$1`, [caseId]);
      await client.query(`update demand_requests set state='completed',updated_at=now() where id=$1`, [serviceCase.demand_id]);
      await appendEvent(client, caseId, 'CASE_OUTCOME_RECORDED', { outcome: body.outcome || 'completed', note: body.note || null });
      return { case: serviceCase, outcome: { state: 'completed', completed: true, outcome: body.outcome || 'completed' } };
    }
    throw new Error(`outcome_not_allowed:${serviceCase.state}`);
  });
}

async function getServicePlan(env, caseId) {
  return await withClient(env, async (client) => {
    const plan = await client.query(`select * from service_plans where case_id=$1`, [caseId]);
    if (!plan.rowCount) throw new Error('service_plan_not_found');
    const id = plan.rows[0].id;
    const [revisions, tasks, commitments, approvals, quotes] = await Promise.all([
      client.query(`select * from service_plan_revisions where service_plan_id=$1 order by revision desc`, [id]),
      client.query(`select * from service_plan_tasks where service_plan_id=$1 order by revision desc,sequence asc,created_at asc`, [id]),
      client.query(`select * from case_commitments where service_plan_id=$1 order by created_at desc`, [id]),
      client.query(`select * from case_approvals where service_plan_id=$1 order by created_at desc`, [id]),
      client.query(`select * from service_quotes where service_plan_id=$1 order by revision desc`, [id])
    ]);
    return { plan: plan.rows[0], revisions: revisions.rows, tasks: tasks.rows, commitments: commitments.rows, approvals: approvals.rows, quotes: quotes.rows };
  });
}

async function runE2E(env) {
  const created = await createCase(env, {
    priority: 'urgent', drivability: 'non_drivable', concern: 'Vehicle will not start; dashboard warning present.',
    location: { label: 'automated-e2e' }, attributes: { source: 'automated_e2e' }
  });
  const caseId = created.case.id;
  const triage = await triageCase(env, caseId, { concern: 'Vehicle will not start; dashboard warning present.', drivability: 'non_drivable' });
  const transport = await createTransport(env, caseId, { transportType: 'tow', pickupLocation: { label: 'vehicle' }, dropoffLocation: { label: 'service-provider' } });
  const delivered = await updateTransport(env, caseId, transport.transport.id, { status: 'delivered', nextState: 'provider_selection' });
  const routing = await routeCase(env, caseId, { capability: 'repair' });
  const approval = await approveCase(env, caseId, { reason: 'Automated end-to-end approval' });
  const serviceOrder = await createServiceOrder(env, caseId, { title: 'Automated repair coordination', assignedActorId: routing.routing.selectedProvider?.id || null, start: true });
  const outcome = await completeCase(env, caseId, { outcome: 'completed', note: 'Automated live business-flow verification', paymentSettled: true });
  const plan = await getServicePlan(env, caseId);
  const aggregate = await getCase(env, caseId);
  return { ok: true, caseId, created, triage, transport, delivered, routing, approval, serviceOrder, outcome, servicePlan: plan, aggregate };
}

function errorResponse(error) {
  const message = String(error?.message || error);
  if (message === 'unauthorized') return reply({ ok: false, error: message }, 401);
  if (['case_not_found','service_plan_not_found','demand_not_found','transport_not_found'].includes(message)) return reply({ ok: false, error: message }, 404);
  if (['content_type_must_be_application_json','prompt_required','prompt_too_large','change_reason_required','diagnostic_actor_required','invalid_transport_status','invalid_transport_next_state'].includes(message)) return reply({ ok: false, error: message }, 400);
  if (message.startsWith('invalid_case_transition:') || message.startsWith('transition_role_not_allowed:') || message.startsWith('case_not_ready_for_routing:') ||
      message.startsWith('triage_requires_intake:') || message.startsWith('transport_requires_tow_pending:') || message.startsWith('diagnostic_requires_diagnostic_state:') ||
      message.startsWith('service_order_not_allowed:') || message === 'service_plan_not_approved' || message.startsWith('outcome_not_allowed:')) {
    return reply({ ok: false, error: message }, 409);
  }
  return reply({ ok: false, error: message }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return reply({ ok: true, service: 'roviq-core', runtime: 'cloudflare-worker', databaseTransport: 'hyperdrive-neon', aiBinding: Boolean(env.AI), aiModel: AI_MODEL, businessFlow: 'service-case-v2' });
    }
    if (url.pathname === '/ready') {
      try {
        const result = await query(env, `select now() as database_time,current_database() as database_name,current_user as database_user,(select count(*)::int from schema_migrations) as migration_count`);
        return reply({ ok: true, service: 'roviq-core', database: 'reachable', databaseTransport: 'hyperdrive-neon', aiBinding: Boolean(env.AI), ...result.rows[0] });
      } catch (error) { return errorResponse(error); }
    }
    if (url.pathname === '/api/core/status') {
      try {
        const result = await query(env, `select (select count(*)::int from actors) as actors,(select count(*)::int from domains) as domains,(select count(*)::int from service_cases) as service_cases,(select count(*)::int from demand_requests) as demand_requests,(select count(*)::int from transport_dispatches) as transport_dispatches,(select count(*)::int from diagnostic_findings) as diagnostic_findings`);
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

    const caseMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)$/i);
    const casePlanMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/service-plan$/i);
    const revisePlanMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/service-plan\/revisions$/i);
    const triageMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/triage$/i);
    const routingMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/routing$/i);
    const transportMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/transport$/i);
    const transportStatusMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/transport\/([0-9a-f-]+)$/i);
    const diagnosticMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/diagnostics$/i);
    const serviceOrderMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/service-orders$/i);
    const approvalMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/approvals$/i);
    const outcomeMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/outcome$/i);

    try {
      if (url.pathname === '/api/demands' && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await createDemand(env, await readJson(request)), 201);
      }
      if (url.pathname === '/api/maintenance/cases' && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await createCase(env, await readJson(request)), 201);
      }
      if (caseMatch && request.method === 'GET') {
        requireInternalAuth(request, env);
        return reply(await getCase(env, caseMatch[1]));
      }
      if (casePlanMatch && request.method === 'GET') {
        requireInternalAuth(request, env);
        return reply(await getServicePlan(env, casePlanMatch[1]));
      }
      if (revisePlanMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await reviseServicePlan(env, revisePlanMatch[1], await readJson(request)), 201);
      }
      if (triageMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await triageCase(env, triageMatch[1], await readJson(request)));
      }
      if (routingMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await routeCase(env, routingMatch[1], await readJson(request)));
      }
      if (transportMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await createTransport(env, transportMatch[1], await readJson(request)), 201);
      }
      if (transportStatusMatch && request.method === 'PATCH') {
        requireInternalAuth(request, env);
        return reply(await updateTransport(env, transportStatusMatch[1], transportStatusMatch[2], await readJson(request)));
      }
      if (diagnosticMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await createDiagnosticFinding(env, diagnosticMatch[1], await readJson(request)), 201);
      }
      if (serviceOrderMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await createServiceOrder(env, serviceOrderMatch[1], await readJson(request)), 201);
      }
      if (approvalMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return reply(await approveCase(env, approvalMatch[1], await readJson(request)), 201);
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

    return reply({ ok: false, error: 'not_found' }, 404);
  }
};
