import { timingSafeEqual } from 'node:crypto';
import { Client } from 'pg';
import baseWorker from './hyperdrive-worker.js';

function json(body, status = 200) {
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
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function tx(env, fn) {
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

async function q(env, text, values = []) {
  return await withClient(env, (client) => client.query(text, values));
}

function errorResponse(error) {
  const message = String(error?.message || error);
  if (message === 'unauthorized') return json({ ok: false, error: message }, 401);
  if (['content_type_must_be_application_json', 'vehicle_required', 'concern_required', 'diagnostic_actor_required'].includes(message)) {
    return json({ ok: false, error: message }, 400);
  }
  if (['case_not_found', 'demand_not_found', 'vehicle_not_found'].includes(message)) return json({ ok: false, error: message }, 404);
  return json({ ok: false, error: message }, 503);
}

async function productionIntake(env, body = {}) {
  const vehicleInput = body.vehicle || {};
  if (!vehicleInput.vin && !(vehicleInput.make && vehicleInput.model)) throw new Error('vehicle_required');
  if (!String(body.concern || '').trim()) throw new Error('concern_required');

  return await tx(env, async (client) => {
    const domainResult = await client.query(`select id from domains where code='maintenance' and status='active' limit 1`);
    if (!domainResult.rowCount) throw new Error('maintenance_domain_missing');
    const domainId = domainResult.rows[0].id;

    let vehicle;
    if (vehicleInput.vin) {
      const existing = await client.query(`select * from vehicles where upper(vin)=upper($1) limit 1`, [vehicleInput.vin]);
      vehicle = existing.rows[0] || null;
    }
    if (!vehicle) {
      const createdVehicle = await client.query(
        `insert into vehicles(owner_actor_id,vin,year,make,model,trim,powertrain,odometer_value,odometer_unit,attributes)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) returning *`,
        [
          body.customerActorId || null,
          vehicleInput.vin || null,
          vehicleInput.year || null,
          vehicleInput.make || null,
          vehicleInput.model || null,
          vehicleInput.trim || null,
          vehicleInput.powertrain || null,
          vehicleInput.odometerValue ?? null,
          vehicleInput.odometerUnit || 'miles',
          JSON.stringify(vehicleInput.attributes || {})
        ]
      );
      vehicle = createdVehicle.rows[0];
    }

    const demand = await client.query(
      `insert into demand_requests(domain_id,requester_actor_id,demand_type,location,urgency,attributes,state)
       values($1,$2,'vehicle_service',$3::jsonb,$4,$5::jsonb,'open') returning *`,
      [
        domainId,
        body.customerActorId || null,
        JSON.stringify(body.location || {}),
        body.priority || 'normal',
        JSON.stringify({ concern: String(body.concern).trim(), vehicleId: vehicle.id, requestedCapability: body.requestedCapability || 'repair', source: body.source || 'api' })
      ]
    );

    const serviceCase = await client.query(
      `insert into service_cases(domain_id,demand_id,customer_actor_id,vehicle_id,case_type,state,priority,drivability,attributes)
       values($1,$2,$3,$4,'maintenance','intake',$5,$6,$7::jsonb) returning *`,
      [
        domainId,
        demand.rows[0].id,
        body.customerActorId || null,
        vehicle.id,
        body.priority || 'normal',
        body.drivability || 'unknown',
        JSON.stringify({ concern: String(body.concern).trim(), requestedCapability: body.requestedCapability || 'repair', source: body.source || 'api' })
      ]
    );

    const summary = 'ROVIQ received the vehicle concern and opened a coordinated service case.';
    const plan = await client.query(
      `insert into service_plans(case_id,status,current_revision,customer_summary,created_by_actor_id)
       values($1,'draft',1,$2,$3) returning *`,
      [serviceCase.rows[0].id, summary, body.customerActorId || null]
    );
    await client.query(
      `insert into service_plan_revisions(service_plan_id,revision,change_reason,customer_summary,plan_snapshot,created_by_actor_id)
       values($1,1,'Production intake created',$2,$3::jsonb,$4)`,
      [plan.rows[0].id, summary, JSON.stringify({ concern: String(body.concern).trim(), vehicleId: vehicle.id, demandId: demand.rows[0].id, tasks: [] }), body.customerActorId || null]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values
       ('service_case',$1,'CASE_CREATED',$2,$3::jsonb),
       ('service_case',$1,'DEMAND_CREATED',$2,$4::jsonb),
       ('service_case',$1,'SERVICE_PLAN_CREATED',$2,$5::jsonb)`,
      [
        serviceCase.rows[0].id,
        body.customerActorId || null,
        JSON.stringify({ state: 'intake', priority: serviceCase.rows[0].priority, vehicleId: vehicle.id }),
        JSON.stringify({ demandId: demand.rows[0].id }),
        JSON.stringify({ servicePlanId: plan.rows[0].id, revision: 1 })
      ]
    );

    return { ok: true, vehicle, demand: demand.rows[0], case: serviceCase.rows[0], servicePlan: plan.rows[0] };
  });
}

async function productionRoute(env, caseId) {
  return await tx(env, async (client) => {
    const caseResult = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!caseResult.rowCount) throw new Error('case_not_found');
    const serviceCase = caseResult.rows[0];
    if (!serviceCase.demand_id) throw new Error('demand_not_found');

    const requestedCapability = serviceCase.attributes?.requestedCapability || 'repair';
    const candidates = await client.query(
      `select
         a.id,
         a.actor_type,
         c.capability_code,
         pc.earliest_available_at,
         pc.max_active_jobs,
         coalesce(pc.routing_enabled,true) as routing_enabled,
         coalesce(active_jobs.count,0)::int as active_jobs,
         coalesce(capacity.available_quantity,0) as available_quantity
       from actors a
       join actor_capabilities ac on ac.actor_id=a.id and ac.active=true
       join capabilities c on c.id=ac.capability_id and c.capability_code=$1
       left join partner_controls pc on pc.actor_id=a.id
       left join lateral (
         select count(*)::int as count
         from case_commitments cc
         where cc.provider_actor_id=a.id and cc.state in ('proposed','accepted')
       ) active_jobs on true
       left join lateral (
         select coalesce(sum(cs.quantity),0) as available_quantity
         from capacity_snapshots cs
         where cs.actor_id=a.id and cs.start_at <= now() and cs.end_at > now()
       ) capacity on true
       where a.status='active'
         and coalesce(pc.routing_enabled,true)=true
         and (pc.earliest_available_at is null or pc.earliest_available_at <= now())
         and (pc.max_active_jobs is null or coalesce(active_jobs.count,0) < pc.max_active_jobs)
       order by
         case when coalesce(capacity.available_quantity,0) > 0 then 0 else 1 end,
         pc.earliest_available_at nulls first,
         case a.actor_type when 'service_provider' then 0 when 'dealership' then 1 when 'diagnostic' then 2 else 3 end,
         a.created_at asc
       limit 20`,
      [requestedCapability]
    );

    const eligible = candidates.rows;
    const selected = eligible[0] || null;
    const decision = await client.query(
      `insert into routing_decisions(demand_id,eligible_actor_ids,rejected_candidates,ranking_trace,selected_actor_id,decision_basis)
       values($1,$2::jsonb,'[]'::jsonb,$3::jsonb,$4,$5) returning *`,
      [
        serviceCase.demand_id,
        JSON.stringify(eligible.map((row) => row.id)),
        JSON.stringify(eligible.map((row, index) => ({ rank: index + 1, actorId: row.id, actorType: row.actor_type, activeJobs: row.active_jobs, capacity: row.available_quantity, earliestAvailableAt: row.earliest_available_at }))),
        selected?.id || null,
        selected ? `Capability=${requestedCapability}; routing controls and active capacity evaluated` : `No eligible provider for capability=${requestedCapability}`
      ]
    );

    if (!selected) {
      const exception = await client.query(
        `insert into case_exceptions(case_id,exception_code,severity,state,summary,metadata)
         values($1,'NO_ELIGIBLE_PROVIDER','warning','open',$2,$3::jsonb) returning *`,
        [caseId, `No eligible provider is currently available for ${requestedCapability}.`, JSON.stringify({ requestedCapability, routingDecisionId: decision.rows[0].id })]
      );
      await client.query(
        `update service_cases set state='provider_selection',updated_at=now(),version=version+1 where id=$1`,
        [caseId]
      );
      await client.query(
        `insert into events(aggregate_type,aggregate_id,event_type,payload)
         values('service_case',$1,'ROUTING_EXCEPTION',$2::jsonb)`,
        [caseId, JSON.stringify({ exceptionId: exception.rows[0].id, code: 'NO_ELIGIBLE_PROVIDER', requestedCapability })]
      );
      return { ok: true, selected: null, routingDecision: decision.rows[0], exception: exception.rows[0] };
    }

    const plan = await client.query(`select id from service_plans where case_id=$1 limit 1`, [caseId]);
    const commitment = await client.query(
      `insert into case_commitments(case_id,service_plan_id,commitment_type,provider_actor_id,state,terms)
       values($1,$2,$3,$4,'proposed',$5::jsonb) returning *`,
      [caseId, plan.rows[0]?.id || null, requestedCapability, selected.id, JSON.stringify({ routingDecisionId: decision.rows[0].id, selectedBy: 'production-routing-v1' })]
    );
    const updated = await client.query(
      `update service_cases set state='provider_pending',current_owner_actor_id=$1,current_owner_role=$2,updated_at=now(),version=version+1 where id=$3 returning *`,
      [selected.id, selected.actor_type, caseId]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'ROUTING_COMPLETED',$2::jsonb),('service_case',$1,'CASE_PROVIDER_PENDING',$3::jsonb)`,
      [caseId, JSON.stringify({ routingDecisionId: decision.rows[0].id, providerActorId: selected.id, capability: requestedCapability }), JSON.stringify({ providerActorId: selected.id })]
    );
    return { ok: true, selected, routingDecision: decision.rows[0], commitment: commitment.rows[0], case: updated.rows[0] };
  });
}

async function recordDiagnostic(env, caseId, body = {}) {
  if (!body.diagnosticActorId) throw new Error('diagnostic_actor_required');
  return await tx(env, async (client) => {
    const caseResult = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!caseResult.rowCount) throw new Error('case_not_found');
    const serviceCase = caseResult.rows[0];
    if (!serviceCase.demand_id) throw new Error('demand_not_found');
    const finding = await client.query(
      `insert into diagnostic_findings(demand_id,case_id,diagnostic_actor_id,finding_code,summary,drivability,disposition,confidence,details)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning *`,
      [serviceCase.demand_id, caseId, body.diagnosticActorId, body.findingCode || null, body.summary || 'Diagnostic finding recorded', body.drivability || 'unknown', body.disposition || 'route_to_shop', body.confidence ?? null, JSON.stringify(body.details || {})]
    );
    const nextState = body.disposition === 'route_to_tow' || body.drivability === 'non_drivable' ? 'tow_pending' : 'provider_selection';
    const updated = await client.query(
      `update service_cases set drivability=$1,state=$2,updated_at=now(),version=version+1 where id=$3 returning *`,
      [body.drivability || serviceCase.drivability, nextState, caseId]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
       values('service_case',$1,'DIAGNOSTIC_FINDING_RECORDED',$2,$3::jsonb)`,
      [caseId, body.diagnosticActorId, JSON.stringify({ findingId: finding.rows[0].id, disposition: finding.rows[0].disposition, nextState })]
    );
    return { ok: true, finding: finding.rows[0], case: updated.rows[0] };
  });
}

async function requestTransport(env, caseId, body = {}) {
  return await tx(env, async (client) => {
    const caseResult = await client.query(`select * from service_cases where id=$1 for update`, [caseId]);
    if (!caseResult.rowCount) throw new Error('case_not_found');
    const transportType = body.transportType === 'valet' ? 'valet' : 'tow';
    const capabilityCode = transportType === 'tow' ? 'tow' : 'valet';
    const provider = await client.query(
      `select a.id,a.actor_type
       from actors a
       join actor_capabilities ac on ac.actor_id=a.id and ac.active=true
       join capabilities c on c.id=ac.capability_id and c.capability_code=$1
       left join partner_controls pc on pc.actor_id=a.id
       where a.status='active'
         and coalesce(pc.routing_enabled,true)=true
         and ($1 <> 'tow' or coalesce(pc.tow_participation,true)=true)
         and ($1 <> 'valet' or coalesce(pc.valet_participation,true)=true)
       order by pc.earliest_available_at nulls first,a.created_at asc
       limit 1`,
      [capabilityCode]
    );
    const providerActorId = provider.rows[0]?.id || null;
    const dispatch = await client.query(
      `insert into transport_dispatches(case_id,transport_type,provider_actor_id,status,pickup_location,dropoff_location,vehicle_context,assigned_at,metadata)
       values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,case when $3 is not null then now() else null end,$8::jsonb) returning *`,
      [caseId, transportType, providerActorId, providerActorId ? 'assigned' : 'requested', JSON.stringify(body.pickupLocation || {}), JSON.stringify(body.dropoffLocation || {}), JSON.stringify(body.vehicleContext || {}), JSON.stringify({ source: 'production-core' })]
    );
    if (!providerActorId) {
      await client.query(
        `insert into case_exceptions(case_id,exception_code,severity,state,summary,metadata)
         values($1,'NO_TRANSPORT_PROVIDER','warning','open',$2,$3::jsonb)`,
        [caseId, `No ${transportType} provider is currently available.`, JSON.stringify({ transportDispatchId: dispatch.rows[0].id })]
      );
    }
    await client.query(`update service_cases set state='tow_pending',updated_at=now(),version=version+1 where id=$1`, [caseId]);
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'TRANSPORT_REQUESTED',$2::jsonb)`,
      [caseId, JSON.stringify({ transportDispatchId: dispatch.rows[0].id, providerActorId, transportType })]
    );
    return { ok: true, dispatch: dispatch.rows[0], providerFound: Boolean(providerActorId) };
  });
}

async function createException(env, caseId, body = {}) {
  return await tx(env, async (client) => {
    const exists = await client.query(`select id from service_cases where id=$1`, [caseId]);
    if (!exists.rowCount) throw new Error('case_not_found');
    const exception = await client.query(
      `insert into case_exceptions(case_id,exception_code,severity,state,summary,metadata)
       values($1,$2,$3,'open',$4,$5::jsonb) returning *`,
      [caseId, body.exceptionCode || 'OPERATIONAL_EXCEPTION', body.severity || 'warning', body.summary || 'Operational exception requires attention.', JSON.stringify(body.metadata || {})]
    );
    await client.query(
      `insert into events(aggregate_type,aggregate_id,event_type,payload)
       values('service_case',$1,'CASE_EXCEPTION_OPENED',$2::jsonb)`,
      [caseId, JSON.stringify({ exceptionId: exception.rows[0].id, code: exception.rows[0].exception_code, severity: exception.rows[0].severity })]
    );
    return { ok: true, exception: exception.rows[0] };
  });
}

async function caseOverview(env, caseId) {
  const result = await q(env,
    `select sc.*,
            row_to_json(v.*) as vehicle,
            row_to_json(dr.*) as demand,
            row_to_json(sp.*) as service_plan,
            coalesce((select jsonb_agg(ce order by ce.created_at desc) from case_exceptions ce where ce.case_id=sc.id),'[]'::jsonb) as exceptions,
            coalesce((select jsonb_agg(td order by td.created_at desc) from transport_dispatches td where td.case_id=sc.id),'[]'::jsonb) as transport,
            coalesce((select jsonb_agg(df order by df.created_at desc) from diagnostic_findings df where df.case_id=sc.id),'[]'::jsonb) as diagnostics
     from service_cases sc
     left join vehicles v on v.id=sc.vehicle_id
     left join demand_requests dr on dr.id=sc.demand_id
     left join service_plans sp on sp.case_id=sc.id
     where sc.id=$1`,
    [caseId]
  );
  if (!result.rowCount) throw new Error('case_not_found');
  return { ok: true, overview: result.rows[0] };
}

async function productionE2E(env) {
  const intake = await productionIntake(env, {
    vehicle: { year: 2026, make: 'ROVIQ-Test', model: 'Integration Vehicle', attributes: { synthetic: true } },
    concern: 'Synthetic production-flow verification: intermittent warning indicator.',
    priority: 'normal',
    drivability: 'drivable',
    requestedCapability: 'repair',
    source: 'production_e2e'
  });
  const route = await productionRoute(env, intake.case.id);
  const overview = await caseOverview(env, intake.case.id);
  return { ok: true, caseId: intake.case.id, intake, route, overview };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const caseOverviewMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/overview$/i);
    const productionRouteMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/routing\/production$/i);
    const diagnosticMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/diagnostics$/i);
    const transportMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/transport$/i);
    const exceptionMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/exceptions$/i);

    try {
      if (url.pathname === '/api/intake' && request.method === 'POST') {
        requireInternalAuth(request, env);
        return json(await productionIntake(env, await readJson(request)), 201);
      }
      if (caseOverviewMatch && request.method === 'GET') {
        requireInternalAuth(request, env);
        return json(await caseOverview(env, caseOverviewMatch[1]));
      }
      if (productionRouteMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return json(await productionRoute(env, productionRouteMatch[1]));
      }
      if (diagnosticMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return json(await recordDiagnostic(env, diagnosticMatch[1], await readJson(request)));
      }
      if (transportMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return json(await requestTransport(env, transportMatch[1], await readJson(request)), 201);
      }
      if (exceptionMatch && request.method === 'POST') {
        requireInternalAuth(request, env);
        return json(await createException(env, exceptionMatch[1], await readJson(request)), 201);
      }
      if (url.pathname === '/api/internal/e2e/production-core' && request.method === 'POST') {
        requireInternalAuth(request, env);
        return json(await productionE2E(env), 201);
      }
      if (url.pathname === '/api/core/production-capabilities' && request.method === 'GET') {
        return json({
          ok: true,
          layer: 'production-core-v1',
          capabilities: ['vehicle_intake','demand_case_plan_atomicity','capability_capacity_routing','diagnostics','transport','exception_recovery','case_overview']
        });
      }
    } catch (error) {
      return errorResponse(error);
    }

    return await baseWorker.fetch(request, env, ctx);
  }
};
