const DEFAULT_LOCAL_ORIGIN = 'https://roviq-local2.admytruk79.workers.dev';

const ROUTES = [
  { core: /^\/api\/local\/health$/, upstream: () => '/api/health', methods: ['GET'] },
  { core: /^\/api\/local\/version$/, upstream: () => '/api/version', methods: ['GET'] },
  { core: /^\/api\/local\/places$/, upstream: () => '/api/places', methods: ['GET'] },
  { core: /^\/api\/local\/places\/(\d+)$/, upstream: (m) => `/api/places/${m[1]}`, methods: ['GET'] },
  { core: /^\/api\/local\/places\/(\d+)\/view$/, upstream: (m) => `/api/places/${m[1]}/view`, methods: ['POST'] },
  { core: /^\/api\/local\/submissions$/, upstream: () => '/api/places', methods: ['POST'] },
  { core: /^\/api\/local\/advisories$/, upstream: () => '/api/advisories', methods: ['GET'] },
  { core: /^\/api\/local\/geocode$/, upstream: () => '/api/geocode', methods: ['GET'] },
  { core: /^\/api\/local\/route$/, upstream: () => '/api/route', methods: ['GET'] }
];

function corsHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

export function isLocalCorePath(pathname) {
  return pathname === '/api/local' || pathname.startsWith('/api/local/');
}

export async function handleLocalCoreRequest(request, env, url) {
  if (url.pathname === '/api/local') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({
      ok: true,
      service: 'roviq-local',
      integration: 'roviq-core',
      version: 1,
      endpoints: [
        'GET /api/local/health',
        'GET /api/local/version',
        'GET /api/local/places',
        'GET /api/local/places/:id',
        'POST /api/local/places/:id/view',
        'POST /api/local/submissions',
        'GET /api/local/advisories',
        'GET /api/local/geocode',
        'GET /api/local/route'
      ]
    });
  }

  let selected;
  let match;
  for (const route of ROUTES) {
    const candidate = url.pathname.match(route.core);
    if (candidate) {
      selected = route;
      match = candidate;
      break;
    }
  }

  if (!selected || !match) return json({ error: 'local_route_not_found' }, 404);
  if (!selected.methods.includes(request.method)) {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...corsHeaders(), allow: selected.methods.join(', ') }
    });
  }

  const origin = String(env.ROVIQ_LOCAL_API_URL || DEFAULT_LOCAL_ORIGIN).replace(/\/+$/, '');
  const upstreamUrl = new URL(selected.upstream(match) + url.search, origin);
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('x-roviq-via', 'core-local-adapter');

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().arrayBuffer()
  });

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (error) {
    return json({
      error: 'local_upstream_unreachable',
      detail: String(error?.message || error)
    }, 502);
  }

  const responseBody = await upstreamResponse.arrayBuffer();
  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: corsHeaders(upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8')
  });
}
