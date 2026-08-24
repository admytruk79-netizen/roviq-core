const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  }
});

function requestId(request) {
  return request.headers.get('x-request-id') || crypto.randomUUID();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = requestId(request);

    // Independent edge liveness. This intentionally proves only the edge layer.
    if (url.pathname === '/edge-health') {
      return json({
        ok: true,
        service: 'roviq-edge',
        role: 'tls-routing-proxy',
        requestId: id,
        coreConfigured: Boolean(env.CORE_API_URL)
      }, 200, { 'x-request-id': id });
    }

    if (!env.CORE_API_URL) {
      return json({
        ok: false,
        error: 'core_not_configured',
        service: 'roviq-edge',
        requestId: id
      }, 503, { 'x-request-id': id });
    }

    let core;
    try {
      core = new URL(env.CORE_API_URL);
    } catch {
      return json({
        ok: false,
        error: 'invalid_core_api_url',
        service: 'roviq-edge',
        requestId: id
      }, 503, { 'x-request-id': id });
    }

    const upstream = new URL(url.pathname + url.search, core);
    const headers = new Headers(request.headers);
    headers.set('x-request-id', id);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    headers.delete('host');

    try {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual'
      });

      const outHeaders = new Headers(response.headers);
      outHeaders.set('x-request-id', id);
      outHeaders.set('x-roviq-edge', 'cloudflare');
      outHeaders.set('cache-control', outHeaders.get('cache-control') || 'no-store');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders
      });
    } catch (error) {
      return json({
        ok: false,
        error: 'core_unreachable',
        service: 'roviq-edge',
        requestId: id
      }, 502, { 'x-request-id': id });
    }
  }
};
