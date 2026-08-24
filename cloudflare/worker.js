const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  }
});

function coreUrl(env, requestUrl) {
  if (!env.CORE_API_URL) throw new Error('core_api_not_configured');
  const incoming = new URL(requestUrl);
  const target = new URL(env.CORE_API_URL);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target;
}

async function proxyToCore(request, env) {
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', new URL(request.url).host);
  headers.set('x-roviq-edge', 'cloudflare');
  const init = {
    method: request.method,
    headers,
    redirect: 'manual'
  };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
  return fetch(coreUrl(env, request.url), init);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/edge-health') {
      return json({
        ok: true,
        service: 'roviq-edge-gateway',
        runtime: 'cloudflare-worker',
        authoritativeCore: 'fastify',
        coreConfigured: Boolean(env.CORE_API_URL)
      });
    }

    if (!url.pathname.startsWith('/api/') && url.pathname !== '/ready') {
      return json({ error: 'route_not_found' }, 404);
    }

    try {
      return await proxyToCore(request, env);
    } catch (error) {
      return json({
        ok: false,
        error: 'core_gateway_unavailable',
        detail: String(error?.message || error)
      }, 503);
    }
  }
};
