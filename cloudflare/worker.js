const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  }
});

let neonFactoryPromise;
let pgClientPromise;

function templateToQuery(strings, values) {
  let text = '';
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i];
    if (i < values.length) text += `$${i + 1}`;
  }
  return { text, values };
}

async function hyperdriveSql(env) {
  if (!pgClientPromise) pgClientPromise = import('pg').then((module) => module.Client);
  const Client = await pgClientPromise;
  return async (strings, ...values) => {
    const { text, values: params } = templateToQuery(strings, values);
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    await client.connect();
    try {
      const result = await client.query(text, params);
      return result.rows;
    } finally {
      await client.end();
    }
  };
}

async function directNeonSql(env) {
  if (!env.DATABASE_URL) throw new Error('database_not_configured');
  if (!neonFactoryPromise) {
    neonFactoryPromise = import('@neondatabase/serverless').then((module) => module.neon);
  }
  const neon = await neonFactoryPromise;
  return neon(env.DATABASE_URL);
}

async function sqlFor(env) {
  if (env.HYPERDRIVE?.connectionString) return hyperdriveSql(env);
  return directNeonSql(env);
}

function databaseTransport(env) {
  return env.HYPERDRIVE?.connectionString ? 'hyperdrive-neon' : 'direct-neon';
}

function authorized(request, env) {
  const key = request.headers.get('x-admin-api-key');
  return Boolean(env.ADMIN_API_KEY && key === env.ADMIN_API_KEY);
}

function safety(symptoms = '', observations = {}) {
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
  const flags = rules
    .filter(([, pattern]) => pattern.test(text))
    .map(([code]) => ({
      code,
      severity: 'critical',
      rationale: 'Deterministic ROVIQ safety rule matched reported symptoms.'
    }));
  return { flags, forceNonDrivable: flags.length > 0 };
}

function normalize(value = {}, symptoms = '') {
  const drivability = ['unknown', 'drivable', 'limited', 'non_drivable'];
  return {
    symptomSummary: String(value.symptomSummary || symptoms || 'Vehicle concern reported').slice(0, 1000),
    suggestedCapabilities: Array.isArray(value.suggestedCapabilities)
      ? value.suggestedCapabilities.map(String).slice(0, 8)
      : ['diagnostics'],
    suggestedDrivability: drivability.includes(value.suggestedDrivability)
      ? value.suggestedDrivability
      : 'unknown',
    safetyFlags: Array.isArray(value.safetyFlags) ? value.safetyFlags.slice(0, 12) : [],
    evidence: Array.isArray(value.evidence) ? value.evidence.slice(0, 12) : [],
    confidence: Number.isFinite(Number(value.confidence))
      ? Math.max(0, Math.min(1, Number(value.confidence)))
      : 0.2,
    missingInformation: Array.isArray(value.missingInformation)
      ? value.missingInformation.map(String).slice(0, 12)
      : [],
    suggestedActions: Array.isArray(value.suggestedActions) ? value.suggestedActions.slice(0, 8) : []
  };
}

const triageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symptomSummary: { type: 'string' },
    suggestedCapabilities: { type: 'array', items: { type: 'string' } },
    suggestedDrivability: {
      type: 'string',
      enum: ['unknown', 'drivable', 'limited', 'non_drivable']
    },
    safetyFlags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          severity: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['code', 'severity', 'rationale']
      }
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          statement: { type: 'string' }
        },
        required: ['source', 'statement']
      }
    },
    confidence: { type: 'number' },
    missingInformation: { type: 'array', items: { type: 'string' } },
    suggestedActions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          actionType: { type: 'string' },
          actionPayload: { type: 'object' }
        },
        required: ['actionType']
      }
    }
  },
  required: [
    'symptomSummary',
    'suggestedCapabilities',
    'suggestedDrivability',
    'safetyFlags',
    'evidence',
    'confidence',
    'missingInformation',
    'suggestedActions'
  ]
};

async function runTriage(env, body) {
  const { caseId, symptoms, vehicle = {}, observations = {} } = body || {};
  if (!caseId || !symptoms) return { error: 'caseId_and_symptoms_required', status: 400 };

  const sql = await sqlFor(env);
  const cases = await sql`select id from service_cases where id = ${caseId} limit 1`;
  if (!cases.length) return { error: 'service_case_not_found', status: 404 };

  let raw;
  try {
    const response = await env.AI.run(
      env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      {
        messages: [
          {
            role: 'system',
            content: 'You are ROVIQ automotive triage. Be conservative. Never select providers or claim a definitive diagnosis. Return only structured JSON for safety, drivability, missing information, and required capabilities.'
          },
          {
            role: 'user',
            content: JSON.stringify({ symptoms, vehicle, observations })
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: triageSchema
        },
        temperature: 0
      }
    );
    raw = response?.response ?? response;
    if (typeof raw === 'string') raw = JSON.parse(raw);
  } catch {
    raw = {
      symptomSummary: symptoms,
      suggestedCapabilities: ['diagnostics'],
      suggestedDrivability: 'unknown',
      safetyFlags: [],
      evidence: [],
      confidence: 0.2,
      missingInformation: ['Professional diagnostic assessment required'],
      suggestedActions: [{ actionType: 'request_diagnostic_review' }]
    };
  }

  const result = normalize(raw, symptoms);
  const deterministic = safety(symptoms, observations);

  if (deterministic.forceNonDrivable) {
    result.suggestedDrivability = 'non_drivable';
    result.suggestedCapabilities = [
      ...new Set([...result.suggestedCapabilities, 'diagnostics', 'tow'])
    ];
  }
  result.safetyFlags = [...deterministic.flags, ...result.safetyFlags];

  const requiresHumanReview =
    deterministic.forceNonDrivable ||
    result.confidence < Number(env.TRIAGE_AUTO_CONFIDENCE_THRESHOLD || 0.9) ||
    result.safetyFlags.some((flag) => flag.severity === 'critical');

  const mode = env.TRIAGE_DEPLOYMENT_MODE || 'shadow';
  const rows = await sql`
    insert into ai_triage_assessments(
      case_id, source, model_provider, model_name, input_snapshot,
      symptom_summary, suggested_capabilities, suggested_drivability,
      safety_flags, evidence, confidence, requires_human_review, status
    ) values(
      ${caseId},
      'ai_engine',
      'cloudflare-workers-ai',
      ${env.TRIAGE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'},
      ${JSON.stringify({ symptoms, vehicle, observations, mode, databaseTransport: databaseTransport(env) })}::jsonb,
      ${result.symptomSummary},
      ${JSON.stringify(result.suggestedCapabilities)}::jsonb,
      ${result.suggestedDrivability},
      ${JSON.stringify(result.safetyFlags)}::jsonb,
      ${JSON.stringify(result.evidence)}::jsonb,
      ${result.confidence},
      ${requiresHumanReview},
      'proposed'
    ) returning id, created_at
  `;

  return {
    status: 200,
    assessmentId: rows[0].id,
    mode,
    databaseTransport: databaseTransport(env),
    safetyOverride: deterministic.forceNonDrivable,
    requiresHumanReview,
    result,
    createdAt: rows[0].created_at
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/edge-health') {
      return json({
        ok: true,
        service: 'roviq-core',
        runtime: 'cloudflare-worker',
        triage: 'native-shadow',
        databaseTransport: databaseTransport(env)
      });
    }

    try {
      if (url.pathname === '/ready') {
        const sql = await sqlFor(env);
        const rows = await sql`select now() as database_time, current_database() as database_name, current_user as database_user`;
        return json({
          ok: true,
          service: 'roviq-core',
          database: 'reachable',
          databaseTransport: databaseTransport(env),
          databaseTime: rows[0]?.database_time ?? null,
          databaseName: rows[0]?.database_name ?? null,
          databaseUser: rows[0]?.database_user ?? null,
          aiBinding: Boolean(env.AI)
        });
      }

      if (url.pathname === '/api/triage/run' && request.method === 'POST') {
        if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
        if (!env.AI) return json({ error: 'workers_ai_not_bound' }, 503);
        const outcome = await runTriage(env, await request.json());
        return outcome.error
          ? json({ error: outcome.error }, outcome.status)
          : json(outcome);
      }

      return json({
        ok: true,
        service: 'roviq-core',
        runtime: 'cloudflare-worker',
        database: 'neon',
        databaseTransport: databaseTransport(env),
        aiTriage: {
          status: 'shadow',
          endpoint: '/api/triage/run'
        }
      });
    } catch (error) {
      return json({
        ok: false,
        error: 'worker_runtime_error',
        databaseTransport: databaseTransport(env),
        detail: String(error?.message || error)
      }, 500);
    }
  }
};
