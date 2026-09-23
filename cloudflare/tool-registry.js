// Narrow, allow-listed conversational tools for the adaptive ROVIQ front end.
// The model may select a tool; it never receives authority from tool selection.
// Mutating tools remain disabled here until their underlying Core endpoint authorization
// and confirmation/idempotency contracts are explicitly bound.

const DEFINITIONS = Object.freeze({
  get_case_status: { intent: 'service', capability: 'service.read', method: 'GET' },
  list_dispatch_queue: { intent: 'dispatch', capability: 'dispatch.read', method: 'GET' },
  list_dispatch_exceptions: { intent: 'dispatch', capability: 'dispatch.read', method: 'GET' },
  list_tow_assignments: { intent: 'tow', capability: 'tow.read', method: 'GET' },
  list_shop_jobs: { intent: 'shop', capability: 'shop.read', method: 'GET' },
  list_fleet_vehicles: { intent: 'fleet', capability: 'fleet.read', method: 'GET' }
});

export function conversationalToolDefinitions() {
  return Object.entries(DEFINITIONS).map(([name, value]) => ({ name, ...value }));
}

function coreHeaders(request) {
  const headers = new Headers();
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  headers.set('accept', 'application/json');
  return headers;
}

async function coreGet(env, request, path) {
  if (!env.CORE_API_URL) return { error: 'core_api_not_configured', status: 503 };
  const response = await fetch(new URL(path, env.CORE_API_URL), {
    method: 'GET',
    headers: coreHeaders(request)
  });
  const body = await response.json().catch(() => ({ error: 'invalid_core_response' }));
  if (!response.ok) return { error: body.error || 'core_tool_failed', status: response.status, details: body };
  return { status: response.status, data: body };
}

export async function executeConversationTool(name, { env, request, actorContext, session, args = {} }) {
  const definition = DEFINITIONS[name];
  if (!definition) return { error: 'conversation_tool_not_allowed', status: 400 };

  switch (name) {
    case 'get_case_status': {
      const caseId = args.caseId || session?.service_case_id;
      if (!caseId) return { error: 'service_case_required', status: 409 };
      return coreGet(env, request, `/api/maintenance/cases/${encodeURIComponent(caseId)}`);
    }
    case 'list_dispatch_queue': {
      // Existing admin case endpoint already enforces organization/location scope.
      const state = args.state ? `?state=${encodeURIComponent(args.state)}` : '';
      return coreGet(env, request, `/api/admin/cases${state}`);
    }
    case 'list_dispatch_exceptions':
      return coreGet(env, request, '/api/admin/exceptions/v2?active=true');
    case 'list_tow_assignments':
      return coreGet(env, request, '/api/transport/me/dispatches');
    case 'list_shop_jobs': {
      // Case access remains relation-based in Core. Do not expose a network-wide shop queue.
      const actorId = actorContext?.actorId;
      if (!actorId) return { error: 'actor_required', status: 403 };
      return coreGet(env, request, '/api/maintenance/provider/cases');
    }
    case 'list_fleet_vehicles':
      return coreGet(env, request, '/api/fleet/me/vehicles');
    default:
      return { error: 'conversation_tool_not_implemented', status: 501 };
  }
}
