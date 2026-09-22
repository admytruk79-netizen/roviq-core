// Actor context for the Cloudflare conversational gateway.
// Reuses Core's existing principal_identities -> actors -> organization/location/capabilities model.
// This module deliberately does not create a Drive-specific identity or role system.

const ROLES = new Set(['admin','customer','partner','diagnostic','tow','parts','fleet']);

function bearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function base64UrlBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

async function verifyHs256Jwt(token, env) {
  if (!env.JWT_SECRET) throw new Error('jwt_secret_not_configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart(encodedHeader);
  if (header.alg !== 'HS256') throw new Error('invalid_token_algorithm');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!valid) throw new Error('invalid_token_signature');

  const payload = decodeJsonPart(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= now) throw new Error('token_expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now) throw new Error('token_not_active');
  if (env.JWT_ISSUER && payload.iss !== env.JWT_ISSUER) throw new Error('invalid_token_issuer');
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (env.JWT_AUDIENCE && !audience.includes(env.JWT_AUDIENCE)) throw new Error('invalid_token_audience');
  if (!payload.sub || !ROLES.has(payload.role)) throw new Error('invalid_token_payload');
  if (payload.role !== 'admin' && typeof payload.actorId !== 'string') throw new Error('invalid_token_actor');
  return payload;
}

async function capabilitiesFor(sql, actorId) {
  if (!actorId) return [];
  const rows = await sql`
    select distinct c.capability_code
    from actor_capabilities ac
    join capabilities c on c.id=ac.capability_id
    where ac.actor_id=${actorId} and ac.active=true
    order by c.capability_code
  `;
  return rows.map((r) => r.capability_code);
}

export async function resolveConversationActor(request, env, sql) {
  const token = bearerToken(request);
  if (!token) return { authenticated: false, error: 'bearer_token_required' };

  let payload;
  try {
    payload = await verifyHs256Jwt(token, env);
  } catch (error) {
    return { authenticated: false, error: 'invalid_or_expired_token', detail: String(error?.message || error) };
  }

  // Admin identities intentionally have no actor_id in the existing Core schema.
  if (payload.role === 'admin') {
    return {
      authenticated: true,
      identityId: payload.sub,
      actorId: null,
      role: 'admin',
      organizationId: null,
      locationId: null,
      capabilities: [],
      actorType: 'admin'
    };
  }

  const rows = await sql`
    select id,actor_type,display_name,status,organization_id,location_id
    from actors
    where id=${payload.actorId}
    limit 1
  `;
  const actor = rows[0];
  if (!actor || actor.status === 'inactive') return { authenticated: false, error: 'actor_not_available' };

  return {
    authenticated: true,
    identityId: payload.sub,
    actorId: actor.id,
    role: payload.role,
    actorType: actor.actor_type,
    displayName: actor.display_name,
    organizationId: actor.organization_id,
    locationId: actor.location_id,
    capabilities: await capabilitiesFor(sql, actor.id)
  };
}

const ROLE_CAPABILITIES = {
  admin: new Set(['local.read','vehicle.read','service.read','service.write','dispatch.read','dispatch.write','tow.read','tow.write','shop.read','shop.write','fleet.read','fleet.write','journey.read']),
  customer: new Set(['local.read','vehicle.read','service.read','service.write','journey.read']),
  partner: new Set(['vehicle.read','service.read','shop.read','shop.write']),
  diagnostic: new Set(['vehicle.read','service.read','service.write']),
  tow: new Set(['service.read','tow.read','tow.write']),
  parts: new Set(['service.read']),
  fleet: new Set(['vehicle.read','service.read','fleet.read','fleet.write'])
};

const INTENT_READ_CAPABILITY = {
  local_discovery: 'local.read',
  vehicle_issue: 'vehicle.read',
  service: 'service.read',
  dispatch: 'dispatch.read',
  tow: 'tow.read',
  shop: 'shop.read',
  fleet: 'fleet.read',
  journey: 'journey.read'
};

export function conversationCapabilityForIntent(intent) {
  return INTENT_READ_CAPABILITY[intent] || null;
}

export function authorizeConversationCapability(actorContext, capability) {
  if (!actorContext?.authenticated) return { allowed: false, status: 401, error: 'unauthorized' };
  if (!capability) return { allowed: true };
  const allowed = ROLE_CAPABILITIES[actorContext.role] || new Set();
  if (allowed.has(capability)) return { allowed: true };

  // Existing actor_capabilities are domain capability codes (e.g. diagnostics/repair).
  // They supplement a base role; they do not silently grant unrelated dispatcher/admin authority.
  if (capability === 'vehicle.read' && actorContext.capabilities?.includes('diagnostics')) return { allowed: true };
  if ((capability === 'service.read' || capability === 'shop.read') && actorContext.capabilities?.includes('repair')) return { allowed: true };

  return { allowed: false, status: 403, error: 'conversation_capability_forbidden', capability };
}
