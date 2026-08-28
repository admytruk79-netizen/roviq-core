import { handleLocalCoreRequest, isLocalCorePath } from './local-adapter.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-admin-api-key,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-admin-api-key,authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/edge-health') {
      return json({ ok: true, service: 'roviq-core', runtime: 'cloudflare-worker', database: 'neon', aiTriage: 'shadow', engine: 'native-worker-v3', local: '/api/local' });
    }

    try {
      if (isLocalCorePath(url.pathname)) {
        return await handleLocalCoreRequest(request, env, url);
      }

      if (url.pathname === '/ready') {
        const sql = await sqlFor(env);
        const rows = await sql`select now() as database_time, current_database() as database_name, current_user as database_user`;
        return json({ ok: true, service: 'roviq-core', database: 'reachable', ...rows[0], aiBinding: Boolean(env.AI) });
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
            'access-control-allow-methods': 'GET,POST,OPTIONS'
          }
        });
      }

      return json({ error: 'not_found', service: 'roviq-core' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'core_runtime_error', detail: String(error?.message || error) }, 500);
    }
  }
};