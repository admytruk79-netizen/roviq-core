import { Client } from 'pg';

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return reply({
        ok: true,
        service: 'roviq-core',
        runtime: 'cloudflare-worker',
        databaseTransport: 'hyperdrive-neon',
        aiBinding: Boolean(env.AI)
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
          ...result.rows[0]
        });
      } catch (error) {
        return reply({
          ok: false,
          service: 'roviq-core',
          database: 'unreachable',
          databaseTransport: 'hyperdrive-neon',
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
      if (!env.AI) return reply({ ok: false, error: 'workers_ai_binding_missing' }, 503);
      return reply({ ok: true, workersAI: 'bound' });
    }

    return reply({ error: 'not_found' }, 404);
  }
};
