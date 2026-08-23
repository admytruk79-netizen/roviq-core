import { neon } from '@neondatabase/serverless';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symptomSummary: { type: 'string' },
    suggestedCapabilities: { type: 'array', items: { type: 'string' } },
    suggestedDrivability: { type: 'string', enum: ['unknown', 'drivable', 'limited', 'non_drivable'] },
    safetyFlags: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          code: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
          rationale: { type: 'string' }
        },
        required: ['code', 'severity', 'rationale']
      }
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { source: { type: 'string' }, statement: { type: 'string' } },
        required: ['source', 'statement']
      }
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    missingInformation: { type: 'array', items: { type: 'string' } },
    suggestedActions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { actionType: { type: 'string' }, actionPayload: { type: 'object' } },
        required: ['actionType']
      }
    }
  },
  required: ['symptomSummary', 'suggestedCapabilities', 'suggestedDrivability', 'safetyFlags', 'evidence', 'confidence', 'missingInformation', 'suggestedActions']
};

function requireInternal(request, env) {
  const key = request.headers.get('x-admin-api-key');
  return Boolean(env.ADMIN_API_KEY && key && key === env.ADMIN_API_KEY);
}

function safetyRules(symptoms, observations = {}) {
  const text = `${symptoms || ''} ${JSON.stringify(observations)}`.toLowerCase();
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

function normalize(raw, symptoms) {
  const x = raw && typeof raw === 'object' ? raw : {};
  return {
    symptomSummary: String(x.symptomSummary || symptoms || 'Vehicle concern reported').slice(0, 1000),
    suggestedCapabilities: Array.isArray(x.suggestedCapabilities) ? x.suggestedCapabilities.map(String).slice(0, 8) : ['diagnostics'],
    suggestedDrivability: ['unknown', 'drivable', 'limited', 'non_drivable'].includes(x.suggestedDrivability) ? x.suggestedDrivability : 'unknown',
    safetyFlags: Array.isArray(x.safetyFlags) ? x.safetyFlags.slice(0, 12) : [],
    evidence: Array.isArray(x.evidence) ? x.evidence.slice(0, 12) : [],
    confidence: Number.isFinite(Number(x.confidence)) ? Math.max(0, Math.min(1, Number(x.confidence))) : 0.2,
    missingInformation: Array.isArray(x.missingInformation) ? x.missingInformation.map(String).slice(0, 12) : [],
    suggestedActions: Array.isArray(x.suggestedActions) ? x.suggestedActions.slice(0, 8) : []
  };
}

function mergeFlags(primary, secondary) {
  const seen = new Set();
  return [...primary, ...secondary].filter((x) => {
    const key = `${x.code}:${x.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runNativeTriage(env, body) {
  const { caseId, symptoms, vehicle = {}, observations = {} } = body || {};
  if (!caseId || !symptoms) return { error: 'caseId_and_symptoms_required', status: 400 };

  const sql = neon(env.DATABASE_URL);
  const cases = await sql`select id from service_cases where id = ${caseId} limit 1`;
  if (!cases.length) return { error: 'service_case_not_found', status: 404 };

  const started = Date.now();
  let raw;
  try {
    const aiResponse = await env.AI.run(env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content: 'You are the ROVIQ automotive triage engine. Be conservative. Never select or name a provider. Never claim a definitive diagnosis. Identify safety risks, drivability, missing information, and service capabilities likely required. Return only structured JSON matching the requested schema.'
        },
        { role: 'user', content: JSON.stringify({ symptoms, vehicle, observations }) }
      ],
      response_format: { type: 'json_schema', json_schema: TRIAGE_SCHEMA },
      temperature: 0
    });
    raw = aiResponse?.response ?? aiResponse;
    if (typeof raw === 'string') raw = JSON.parse(raw);
  } catch (error) {
    raw = {
      symptomSummary: symptoms,
      suggestedCapabilities: ['diagnostics'],
      suggestedDrivability: 'unknown',
      safetyFlags: [], evidence: [], confidence: 0.2,
      missingInformation: ['Professional diagnostic assessment required'],
      suggestedActions: [{ actionType: 'request_diagnostic_review' }],
      fallbackReason: String(error?.message || error)
    };
  }

  let result = normalize(raw, symptoms);
  const deterministic = safetyRules(symptoms, observations);
  let safetyOverride = false;
  if (deterministic.forceNonDrivable) {
    safetyOverride = true;
    result.suggestedDrivability = 'non_drivable';
    result.suggestedCapabilities = [...new Set([...result.suggestedCapabilities, 'diagnostics', 'tow'])];
  }
  result.safetyFlags = mergeFlags(deterministic.flags, result.safetyFlags);

  const threshold = Number(env.TRIAGE_AUTO_CONFIDENCE_THRESHOLD || '0.90');
  const requiresHumanReview = safetyOverride || result.confidence < threshold || result.safetyFlags.some((x) => x.severity === 'critical');
  const mode = env.TRIAGE_DEPLOYMENT_MODE || 'shadow';

  const rows = await sql`
    insert into ai_triage_assessments (
      case_id, source, model_provider, model_name, input_snapshot, symptom_summary,
      suggested_capabilities, suggested_drivability, safety_flags, evidence,
      confidence, requires_human_review, status
    ) values (
      ${caseId}, 'ai_engine', 'cloudflare-workers-ai', ${env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'},
      ${JSON.stringify({ symptoms, vehicle, observations, deploymentMode: mode, safetyOverride, latencyMs: Date.now() - started })}::jsonb,
      ${result.symptomSummary}, ${JSON.stringify(result.suggestedCapabilities)}::jsonb,
      ${result.suggestedDrivability}, ${JSON.stringify(result.safetyFlags)}::jsonb,
      ${JSON.stringify(result.evidence)}::jsonb, ${result.confidence}, ${requiresHumanReview}, 'proposed'
    ) returning id, created_at
  `;

  const assessmentId = rows[0].id;
  for (const action of result.suggestedActions) {
    await sql`
      insert into ai_triage_actions (assessment_id, action_type, action_payload, state)
      values (${assessmentId}, ${String(action.actionType)}, ${JSON.stringify(action.actionPayload || {})}::jsonb, 'suggested')
    `;
  }

  return {
    status: 200,
    assessmentId,
    mode,
    model: env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    safetyOverride,
    requiresHumanReview,
    result,
    createdAt: rows[0].created_at
  };
}

async function getCaseTriage(env, caseId) {
  const sql = neon(env.DATABASE_URL);
  return sql`
    select id, case_id, source, model_provider, model_name, symptom_summary,
           suggested_capabilities, suggested_drivability, safety_flags, evidence,
           confidence, requires_human_review, status, reviewed_at, review_notes, created_at
    from ai_triage_assessments
    where case_id = ${caseId}
    order by created_at desc
    limit 20
  `;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/edge-health') {
      return json({ ok: true, service: 'roviq-core', runtime: 'cloudflare-worker', triage: 'native-shadow' });
    }

    if (url.pathname === '/ready') {
      if (!env.DATABASE_URL) return json({ ok: false, service: 'roviq-core', database: 'not_configured' }, 503);
      try {
        const sql = neon(env.DATABASE_URL);
        const rows = await sql`select now() as database_time`;
        return json({ ok: true, service: 'roviq-core', database: 'reachable', databaseTime: rows[0]?.database_time ?? null, aiBinding: Boolean(env.AI) });
      } catch (error) {
        return json({ ok: false, service: 'roviq-core', database: 'unreachable', error: String(error?.message || error) }, 503);
      }
    }

    if (url.pathname === '/api/triage/run' && request.method === 'POST') {
      if (!requireInternal(request, env)) return json({ error: 'unauthorized' }, 401);
      if (!env.AI) return json({ error: 'workers_ai_not_bound' }, 503);
      if (!env.DATABASE_URL) return json({ error: 'database_not_configured' }, 503);
      try {
        const body = await request.json();
        const outcome = await runNativeTriage(env, body);
        if (outcome.error) return json({ error: outcome.error }, outcome.status);
        return json(outcome);
      } catch (error) {
        return json({ error: 'triage_failed', detail: String(error?.message || error) }, 500);
      }
    }

    const match = url.pathname.match(/^\/api\/triage\/([0-9a-f-]{36})$/i);
    if (match && request.method === 'GET') {
      if (!requireInternal(request, env)) return json({ error: 'unauthorized' }, 401);
      try {
        const assessments = await getCaseTriage(env, match[1]);
        return json({ caseId: match[1], assessments });
      } catch (error) {
        return json({ error: 'triage_read_failed', detail: String(error?.message || error) }, 500);
      }
    }

    return json({
      ok: true,
      service: 'roviq-core',
      runtime: 'cloudflare-worker',
      database: 'neon',
      aiTriage: { status: 'shadow', endpoint: '/api/triage/run' }
    });
  }
};
