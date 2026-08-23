import { neon } from '@neondatabase/serverless';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/edge-health' || url.pathname === '/health') {
      return json({ ok: true, service: 'roviq-core', runtime: 'cloudflare-worker' });
    }

    if (url.pathname === '/ready') {
      if (!env.DATABASE_URL) {
        return json({ ok: false, service: 'roviq-core', database: 'not_configured' }, 503);
      }
      try {
        const sql = neon(env.DATABASE_URL);
        const rows = await sql`select now() as database_time`;
        return json({
          ok: true,
          service: 'roviq-core',
          runtime: 'cloudflare-worker',
          database: 'reachable',
          databaseTime: rows?.[0]?.database_time ?? null,
          triageMode: env.TRIAGE_DEPLOYMENT_MODE || 'shadow'
        });
      } catch (error) {
        console.error('database_readiness_error', error);
        return json({ ok: false, service: 'roviq-core', database: 'unreachable' }, 503);
      }
    }

    return json({
      ok: false,
      error: 'route_not_migrated',
      service: 'roviq-core',
      message: 'ROVIQ Core native Worker is live; application routes are being migrated from the legacy Node HTTP layer.'
    }, 404);
  }
};
