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

async function query(env, text, values = []) {
  if (!env.HYPERDRIVE?.connectionString) {
    throw new Error('hyperdrive_binding_missing');
  }

  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString
  });

  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runAI(env, prompt, context = null) {
  if (!env.AI?.run) throw new Error('workers_ai_binding_missing');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt_required');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('prompt_too_large');

  const messages = [
    { role: 'system', content: CORE_SYSTEM_PROMPT },
    ...(context == null
      ? []
      : [{ role: 'system', content: `ROVIQ context supplied by the application:\n${JSON.stringify(context)}` }]),
    { role: 'user', content: prompt.trim() }
  ];

  return await env.AI.run(AI_MODEL, { messages });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return reply({
        ok: true,
        service: 'roviq-core',
        runtime: 'cloudflare-worker',
        databaseTransport: 'hyperdrive-neon',
        aiBinding: Boolean(env.AI),
        aiModel: AI_MODEL
      });
    }

    if (url.pathname === '/ready') {
      try {
        const result = await query(env, `
          select now() as database_time,
                 current_database() as database_name,
                 current_user as database_user,
                 (select count(*)::int from schema_migrations) as migration_count
        `);

        return reply({
          ok: true,
          service: 'roviq-core',
          database: 'reachable',
          databaseTransport: 'hyperdrive-neon',
          aiBinding: Boolean(env.AI),
          ...result.rows[0]
        });
      } catch (error) {
        return reply({
          ok: false,
          service: 'roviq-core',
          database: 'unreachable',
          databaseTransport: 'hyperdrive-neon',
          aiBinding: Boolean(env.AI),
          error: String(error?.message || error)
        }, 503);
      }
    }

    if (url.pathname === '/api/core/status') {
      try {
        const result = await query(env, `
          select
            (select count(*)::int from actors) as actors,
            (select count(*)::int from domains) as domains,
            (select count(*)::int from service_cases) as service_cases,
            (select count(*)::int from demand_requests) as demand_requests
        `);
        return reply({ ok: true, counts: result.rows[0] });
      } catch (error) {
        return reply({ ok: false, error: String(error?.message || error) }, 503);
      }
    }

    if (url.pathname === '/api/ai/ping') {
      if (request.method !== 'GET') return reply({ ok: false, error: 'method_not_allowed' }, 405);
      try {
        const result = await runAI(env, 'Reply with exactly: ROVIQ_AI_OK');
        return reply({
          ok: true,
          workersAI: 'inference_ok',
          model: AI_MODEL,
          result
        });
      } catch (error) {
        return reply({
          ok: false,
          workersAI: 'inference_failed',
          model: AI_MODEL,
          error: String(error?.message || error)
        }, 503);
      }
    }

    if (url.pathname === '/api/ai/respond') {
      if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405);
      try {
        const body = await readJson(request);
        const result = await runAI(env, body?.prompt, body?.context ?? null);
        return reply({
          ok: true,
          engine: 'roviq-core-ai',
          model: AI_MODEL,
          result
        });
      } catch (error) {
        const message = String(error?.message || error);
        const clientError = ['content_type_must_be_application_json', 'prompt_required', 'prompt_too_large'].includes(message);
        return reply({ ok: false, engine: 'roviq-core-ai', error: message }, clientError ? 400 : 503);
      }
    }

    return reply({ error: 'not_found' }, 404);
  }
};
