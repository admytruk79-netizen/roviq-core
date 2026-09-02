import { handleLocalCoreRequest, isLocalCorePath } from './local-adapter.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-admin-api-key,authorization',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  }
});

let neonFactoryPromise;

async function sqlFor(env) {
  if (!env.DATABASE_URL) throw new Error('database_not_configured');
  if (!neonFactoryPromise) {
    neonFactoryPromise = import('@neondatabase/serverless').then((module) => module.neon);
  }
  const neon = await neonFactoryPromise;
  return neon(env.DATABASE_URL);
}

function authorized(request, env) {
  const supplied = request.headers.get('x-admin-api-key');
  return Boolean(env.ADMIN_API_KEY && supplied && supplied === env.ADMIN_API_KEY);
}

function safetyRules(symptoms = '', observations = {}) {
  const text = `${symptoms} ${JSON.stringify(observations)}`.toLowerCase();
  const rules = [
    ['fire_or_smoke', /\b(fire|flames|smoke from engine|burning smell)\b/],
    ['fuel_leak', /\b(fuel leak|gasoline leak|strong fuel smell|smells like gas)\b/],
    ['brake_failure', /\b(no brakes|brake failure|brake pedal.*floor)\b/],
    ['steering_failure', /\b(steering locked|cannot steer|steering failure)\b/],
    ['oil_pressure', /\b(oil pressure warning|low oil pressure)\b/],
    ['overheating', /\b(overheating|temperature gauge.*red|coolant.*boiling)\b/],
    ['ev_high_voltage', /\b(high voltage warning|battery fire|thermal runaway)\b/],
    ['severe_misfire', /\b(flashing check engine|engine.*shaking violently|severe misfire)\b/]
  ];
  const flags = rules.filter(([, re]) => re.test(text)).map(([code]) => ({
    code,
    severity: 'critical',
    rationale: 'Deterministic ROVIQ safety rule matched the reported symptoms.'
  }));
  return { flags, forceNonDrivable: flags.length > 0 };
}

function normalize(value, symptoms) {
  const x = value && typeof value === 'object' ? value : {};
  const drivability = ['unknown', 'drivable', 'limited', 'non_drivable'];
  return {
    symptomSummary: String(x.symptomSummary || symptoms || 'Vehicle concern reported').slice(0, 1000),
    suggestedCapabilities: Array.isArray(x.suggestedCapabilities) ? x.suggestedCapabilities.map(String).slice(0, 8) : ['diagnostics'],
    suggestedDrivability: drivability.includes(x.suggestedDrivability) ? x.suggestedDrivability : 'unknown',
    safetyFlags: Array.isArray(x.safetyFlags) ? x.safetyFlags.slice(0, 12) : [],
    evidence: Array.isArray(x.evidence) ? x.evidence.slice(0, 12) : [],
    confidence: Number.isFinite(Number(x.confidence)) ? Math.max(0, Math.min(1, Number(x.confidence))) : 0.2,
    missingInformation: Array.isArray(x.missingInformation) ? x.missingInformation.map(String).slice(0, 12) : [],
    suggestedActions: Array.isArray(x.suggestedActions) ? x.suggestedActions.slice(0, 8) : []
  };
}

async function runTriage(env, body) {
  const { caseId, symptoms, vehicle = {}, observations = {} } = body || {};
  if (!caseId || !symptoms) return { error: 'caseId_and_symptoms_required', status: 400 };

  const sql = await sqlFor(env);
  const existing = await sql`select id from service_cases where id = ${caseId} limit 1`;
  if (!existing.length) return { error: 'service_case_not_found', status: 404 };

  const started = Date.now();
  let raw;
  try {
    const response = await env.AI.run(env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You are the ROVIQ automotive triage engine. Be conservative. Never make a definitive diagnosis, never choose a provider, and prioritize safety and drivability. Return valid JSON with symptomSummary, suggestedCapabilities, suggestedDrivability, safetyFlags, evidence, confidence, missingInformation, and suggestedActions.' },
        { role: 'user', content: JSON.stringify({ symptoms, vehicle, observations }) }
      ],
      temperature: 0
    });
    raw = response?.response ?? response;
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      raw = JSON.parse(cleaned);
    }
  } catch (error) {
    raw = {
      symptomSummary: symptoms,
      suggestedCapabilities: ['diagnostics'],
      suggestedDrivability: 'unknown',
      safetyFlags: [],
      evidence: [],
      confidence: 0.2,
      missingInformation: ['Professional diagnostic assessment required'],
      suggestedActions: [{ actionType: 'request_diagnostic_review' }],
      fallbackReason: String(error?.message || error)
    };
  }

  const result = normalize(raw, symptoms);
  const deterministic = safetyRules(symptoms, observations);
  if (deterministic.forceNonDrivable) {
    result.suggestedDrivability = 'non_drivable';
    result.suggestedCapabilities = [...new Set([...result.suggestedCapabilities, 'diagnostics', 'tow'])];
  }
  result.safetyFlags = [...deterministic.flags, ...result.safetyFlags];

  const threshold = Number(env.TRIAGE_AUTO_CONFIDENCE_THRESHOLD || '0.90');
  const requiresHumanReview = deterministic.forceNonDrivable || result.confidence < threshold || result.safetyFlags.some((f) => f.severity === 'critical');
  const mode = env.TRIAGE_DEPLOYMENT_MODE || 'shadow';
  const latencyMs = Date.now() - started;

  const inserted = await sql`
    insert into ai_triage_assessments (
      case_id, source, model_provider, model_name, input_snapshot,
      symptom_summary, suggested_capabilities, suggested_drivability,
      safety_flags, evidence, confidence, requires_human_review, status,
      engine_version, deployment_mode, safety_override, safety_override_reason,
      raw_model_output, latency_ms
    ) values (
      ${caseId}, 'ai_engine', 'cloudflare-workers-ai',
      ${env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'},
      ${JSON.stringify({ symptoms, vehicle, observations })}::jsonb,
      ${result.symptomSummary}, ${JSON.stringify(result.suggestedCapabilities)}::jsonb,
      ${result.suggestedDrivability}, ${JSON.stringify(result.safetyFlags)}::jsonb,
      ${JSON.stringify(result.evidence)}::jsonb, ${result.confidence}, ${requiresHumanReview},
      'proposed', 'native-worker-v3', ${mode}, ${deterministic.forceNonDrivable},
      ${deterministic.forceNonDrivable ? 'deterministic_safety_rule' : null},
      ${JSON.stringify(raw || {})}::jsonb, ${latencyMs}
    ) returning id, created_at
  `;

  return {
    status: 200,
    assessmentId: inserted[0].id,
    mode,
    database: 'neon',
    runtime: 'cloudflare-worker',
    safetyOverride: deterministic.forceNonDrivable,
    requiresHumanReview,
    result,
    createdAt: inserted[0].created_at
  };
}

async function sweepExpiredDeadlinesNative(sql, limit = 200) {
  const expired = await sql`
    select * from workflow_deadlines
    where state='open' and due_at<=now()
    order by due_at asc
    limit ${limit}
  `;
  const processed = [];
  for (const d of expired) {
    const nextRetry = Number(d.retry_count || 0) + 1;
    const payload = {
      deadlineId: d.id,
      deadlineType: d.deadline_type,
      retryCount: nextRetry,
      fallbackAction: d.fallback_action,
      source: 'cloudflare_cron'
    };
    if (nextRetry <= Number(d.max_retries || 0)) {
      await sql`update workflow_deadlines set retry_count=${nextRetry},due_at=now()+interval '2 minutes' where id=${d.id}`;
      await sql`
        insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
        values('service_case',${d.case_id},'WORKFLOW_RETRY_SCHEDULED',null,${JSON.stringify(payload)}::jsonb)
      `;
      processed.push({ id: d.id, action: 'retry', retryCount: nextRetry });
    } else {
      await sql`update workflow_deadlines set state='expired',resolved_at=now() where id=${d.id}`;
      const exceptions = await sql`
        insert into case_exceptions(case_id,exception_code,severity,summary,metadata)
        values(
          ${d.case_id},
          ${`DEADLINE_${String(d.deadline_type).toUpperCase()}`},
          'warning',
          ${`Workflow deadline expired: ${d.deadline_type}`},
          ${JSON.stringify({ deadlineId: d.id, fallbackAction: d.fallback_action, source: 'cloudflare_cron' })}::jsonb
        ) returning id
      `;
      await sql`
        insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
        values(
          'service_case',${d.case_id},'WORKFLOW_ESCALATED',null,
          ${JSON.stringify({ deadlineId: d.id, exceptionId: exceptions[0].id, fallbackAction: d.fallback_action, source: 'cloudflare_cron' })}::jsonb
        )
      `;
      processed.push({ id: d.id, action: 'escalated', exceptionId: exceptions[0].id });
    }
  }
  return processed;
}

async function retryNotificationNative(sql, notification, attemptNumber, provider, errorMessage) {
  const dead = attemptNumber >= Number(notification.max_attempts || 5);
  const delaySeconds = Math.min(3600, Math.pow(2, Math.max(0, attemptNumber - 1)) * 30);
  await sql`
    update notification_outbox
    set state=${dead ? 'dead' : 'pending'},attempt_count=${attemptNumber},provider=${provider},last_error=${errorMessage},
        available_at=case when ${dead ? 'dead' : 'pending'}='pending' then now()+(${String(delaySeconds)} || ' seconds')::interval else available_at end,
        locked_at=null,locked_by=null
    where id=${notification.id}
  `;
  return dead ? 'dead' : 'retry';
}

async function processNotificationBatchNative(sql, workerId = 'cloudflare-cron', limit = 200) {
  const claimed = await sql`
    with candidates as (
      select id from notification_outbox
      where state='pending' and available_at<=now() and (locked_at is null or locked_at < now()-interval '5 minutes')
      order by created_at asc
      for update skip locked
      limit ${limit}
    )
    update notification_outbox n set locked_at=now(),locked_by=${workerId}
    from candidates c where n.id=c.id returning n.*
  `;

  const results = [];
  for (const n of claimed) {
    const attemptNumber = Number(n.attempt_count || 0) + 1;
    const configs = await sql`select * from notification_channel_configs where channel=${n.channel}`;
    const provider = n.provider || configs[0]?.provider || 'internal';
    if (!configs.length || !configs[0].enabled) {
      const message = 'Notification channel is disabled';
      await sql`
        insert into notification_delivery_attempts(notification_id,attempt_number,provider,state,error_code,error_message)
        values(${n.id},${attemptNumber},${provider},'failed','channel_disabled',${message})
      `;
      results.push({ id: n.id, state: await retryNotificationNative(sql, n, attemptNumber, provider, message) });
      continue;
    }

    const templates = await sql`
      select * from notification_templates
      where template_key=${n.template_key} and channel=${n.channel} and active=true
      order by version desc limit 1
    `;
    const template = templates[0];
    const payload = n.payload || {};
    const render = (value) => String(value || '').replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_m, key) => payload[key] == null ? '' : String(payload[key]));
    const subject = template?.subject_template ? render(template.subject_template) : undefined;
    const body = template?.body_template ? render(template.body_template) : JSON.stringify(payload);

    if (provider !== 'internal') {
      const message = `No adapter registered for ${provider}`;
      await sql`
        insert into notification_delivery_attempts(notification_id,attempt_number,provider,state,error_code,error_message)
        values(${n.id},${attemptNumber},${provider},'failed','provider_not_configured',${message})
      `;
      results.push({ id: n.id, state: await retryNotificationNative(sql, n, attemptNumber, provider, message) });
      continue;
    }

    const providerMessageId = `internal:${n.recipient_id}:${Date.now()}`;
    await sql`
      insert into notification_delivery_attempts(
        notification_id,attempt_number,provider,provider_message_id,state,request_payload,response_payload
      ) values(
        ${n.id},${attemptNumber},${provider},${providerMessageId},'sent',
        ${JSON.stringify({ subject, body, recipientId: n.recipient_id })}::jsonb,'{}'::jsonb
      )
    `;
    await sql`
      update notification_outbox
      set state='sent',attempt_count=${attemptNumber},provider=${provider},provider_message_id=${providerMessageId},
          sent_at=now(),locked_at=null,locked_by=null,last_error=null
      where id=${n.id}
    `;
    await sql`
      insert into audit_log(principal_role,principal_actor_id,action,object_type,object_id,rule_basis,metadata)
      values('system',null,'notification_sent','notification',${n.id},${provider},${JSON.stringify({ channel: n.channel, templateKey: n.template_key, source: 'cloudflare_cron' })}::jsonb)
    `;
    results.push({ id: n.id, state: 'sent', providerMessageId });
  }
  return results;
}

export async function pingCore(env) {
  // Render's free tier spins Core down after ~15 minutes with no HTTP traffic, and takes 30-60s to
  // wake back up on the next request -- long enough that a real user's portal request gives up and
  // shows "Core temporarily unreachable" first. This cron already fires every 10 minutes (see
  // wrangler.jsonc's triggers.crons) for the DB sweep below, well under that 15-minute window, so
  // piggybacking a lightweight health request on it keeps Core continuously warm. Best-effort: a
  // failure here must not fail the deadline/notification sweep this function also runs.
  if (!env.CORE_API_URL) return { ok: false, reason: 'core_api_not_configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch(new URL('/health', env.CORE_API_URL), { signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function runScheduledOperations(env) {
  const sql = await sqlFor(env);
  const [deadlines, notifications, corePing] = await Promise.all([
    sweepExpiredDeadlinesNative(sql, 200),
    processNotificationBatchNative(sql, 'cloudflare-cron', 200),
    pingCore(env)
  ]);
  console.log(JSON.stringify({ event: 'scheduled_operations_complete', deadlines: deadlines.length, notifications: notifications.length, corePing }));
  return { deadlines, notifications, corePing };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-admin-api-key,authorization', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' } });
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/edge-health') {
      return json({ ok: true, service: 'roviq-core', runtime: 'cloudflare-worker', database: 'neon', aiTriage: 'shadow', engine: 'native-worker-v3', local: '/api/local', scheduledOperations: 'cloudflare-cron' });
    }

    try {
      if (isLocalCorePath(url.pathname)) {
        return await handleLocalCoreRequest(request, env, url);
      }

      if (url.pathname === '/ready') {
        const sql = await sqlFor(env);
        const rows = await sql`select now() as database_time, current_database() as database_name, current_user as database_user`;
        return json({ ok: true, service: 'roviq-core', database: 'reachable', ...rows[0], aiBinding: Boolean(env.AI), scheduledOperations: 'cloudflare-cron' });
      }

      if (url.pathname === '/api/core/status') {
        const sql = await sqlFor(env);
        const rows = await sql`select
          (select count(*)::int from actors) actors,
          (select count(*)::int from domains) domains,
          (select count(*)::int from service_cases) service_cases,
          (select count(*)::int from demand_requests) demand_requests`;
        return json({ ok: true, service: 'roviq-core', counts: rows[0] });
      }

      if (url.pathname === '/api/triage/run' && request.method === 'POST') {
        if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
        if (!env.AI) return json({ error: 'workers_ai_not_bound' }, 503);
        const result = await runTriage(env, await request.json());
        return result.error ? json({ error: result.error }, result.status) : json(result);
      }

      const match = url.pathname.match(/^\/api\/triage\/([0-9a-f-]{36})$/i);
      if (match && request.method === 'GET') {
        if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
        const sql = await sqlFor(env);
        const rows = await sql`
          select id, case_id, model_provider, model_name, symptom_summary,
                 suggested_capabilities, suggested_drivability, safety_flags, evidence,
                 confidence, requires_human_review, status, deployment_mode,
                 safety_override, latency_ms, created_at
          from ai_triage_assessments where case_id = ${match[1]}
          order by created_at desc limit 20
        `;
        return json({ caseId: match[1], assessments: rows });
      }

      if (url.pathname.startsWith('/api/')) {
        if (!env.CORE_API_URL) return json({ error: 'core_api_not_configured' }, 503);
        const upstream = new URL(url.pathname + url.search, env.CORE_API_URL);
        const upstreamRequest = new Request(upstream, {
          method: request.method,
          headers: request.headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().arrayBuffer()
        });
        const upstreamResponse = await fetch(upstreamRequest);
        const responseBody = await upstreamResponse.arrayBuffer();
        return new Response(responseBody, {
          status: upstreamResponse.status,
          headers: {
            'content-type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type,x-admin-api-key,authorization',
            'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
          }
        });
      }

      return json({ error: 'not_found', service: 'roviq-core' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'core_runtime_error', detail: String(error?.message || error) }, 500);
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledOperations(env));
  }
};