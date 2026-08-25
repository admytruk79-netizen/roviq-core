import { scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { Client } from 'pg';
import productionWorker from './production-worker.js';

const JWT_ISSUER = 'roviq-core';
const JWT_AUDIENCE = 'roviq-apps';
const JWT_TTL = '8h';
const ALLOWED_ROLES = new Set(['admin','customer','partner','diagnostic','tow','parts','fleet']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('content_type_must_be_application_json');
  return await request.json();
}

async function withClient(env, fn) {
  if (!env.HYPERDRIVE?.connectionString) throw new Error('hyperdrive_binding_missing');
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end().catch(() => undefined); }
}

function jwtSecret(env) {
  if (!env.ROVIQ_JWT_SECRET || String(env.ROVIQ_JWT_SECRET).length < 32) throw new Error('jwt_secret_not_configured');
  return new TextEncoder().encode(String(env.ROVIQ_JWT_SECRET));
}

function verifyPassword(password, salt, expectedHash) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function issueAccessToken(env, identityId, role, actorId = null) {
  if (!ALLOWED_ROLES.has(role)) throw new Error('invalid_role');
  if (role !== 'admin' && !actorId) throw new Error('invalid_token_actor');
  return await new SignJWT({ role, actorId: actorId || undefined })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(identityId))
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(JWT_TTL)
    .sign(jwtSecret(env));
}

async function principalFromRequest(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new Error('unauthorized');
  const token = auth.slice(7);
  try {
    const { payload } = await jwtVerify(token, jwtSecret(env), { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    const role = String(payload.role || '');
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    if (!payload.sub || !ALLOWED_ROLES.has(role)) throw new Error('invalid_token_payload');
    if (role !== 'admin' && !actorId) throw new Error('invalid_token_actor');
    return { identityId: String(payload.sub), role, actorId };
  } catch (error) {
    if (String(error?.message || error) === 'jwt_secret_not_configured') throw error;
    throw new Error('unauthorized');
  }
}

async function login(env, body = {}) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) throw new Error('credentials_required');
  return await withClient(env, async (client) => {
    const result = await client.query(
      `select id,actor_id,email,role,password_salt,password_hash,active
         from principal_identities
        where lower(email)=lower($1)
        limit 1`, [email]
    );
    const identity = result.rows[0];
    if (!identity || !identity.active || !verifyPassword(password, identity.password_salt, identity.password_hash)) throw new Error('invalid_credentials');
    const token = await issueAccessToken(env, identity.id, identity.role, identity.actor_id);
    return { ok: true, accessToken: token, tokenType: 'Bearer', expiresIn: 28800, principal: { identityId: identity.id, role: identity.role, actorId: identity.actor_id, email: identity.email } };
  });
}

async function caseAccessRecord(client, caseId, principal) {
  const result = await client.query(
    `select sc.id,sc.customer_actor_id,sc.current_owner_actor_id,
            exists(select 1 from case_commitments cc where cc.case_id=sc.id and cc.provider_actor_id=$2) as has_provider_relation,
            exists(select 1 from transport_dispatches td where td.case_id=sc.id and td.provider_actor_id=$2) as has_transport_relation,
            exists(select 1 from parts_orders po where po.case_id=sc.id and po.supplier_actor_id=$2) as has_parts_relation,
            exists(select 1 from mobility_allocations ma where ma.case_id=sc.id and ma.provider_actor_id=$2) as has_mobility_relation
       from service_cases sc where sc.id=$1`, [caseId, principal.actorId]
  );
  return result.rows[0] || null;
}

function canAccessCase(principal, record) {
  if (!record) return false;
  if (principal.role === 'admin') return true;
  if (!principal.actorId) return false;
  if (principal.role === 'customer') return record.customer_actor_id === principal.actorId;
  if (record.current_owner_actor_id === principal.actorId) return true;
  if (['partner','diagnostic'].includes(principal.role)) return record.has_provider_relation;
  if (principal.role === 'tow') return record.has_transport_relation;
  if (principal.role === 'parts') return record.has_parts_relation;
  if (principal.role === 'fleet') return record.has_mobility_relation;
  return false;
}

async function caseProjection(env, principal, caseId) {
  return await withClient(env, async (client) => {
    const access = await caseAccessRecord(client, caseId, principal);
    if (!access) throw new Error('case_not_found');
    if (!canAccessCase(principal, access)) throw new Error('forbidden');

    const c = (await client.query(`select id,customer_actor_id,vehicle_id,state,priority,drivability,current_owner_actor_id,current_owner_role,created_at,updated_at,completed_at,attributes from service_cases where id=$1`, [caseId])).rows[0];
    const vehicle = c.vehicle_id ? (await client.query(`select id,year,make,model,trim,powertrain,odometer_value,odometer_unit,attributes from vehicles where id=$1`, [c.vehicle_id])).rows[0] : null;
    const plan = (await client.query(`select id,status,current_revision,customer_summary,estimated_total_minor,approved_total_minor,currency,approved_at,updated_at from service_plans where case_id=$1`, [caseId])).rows[0] || null;

    if (principal.role === 'customer') {
      const [transport, mobility, approvals] = await Promise.all([
        client.query(`select id,transport_type,status,eta_at,created_at,updated_at,completed_at from transport_dispatches where case_id=$1 order by created_at desc`, [caseId]),
        client.query(`select id,allocation_type,state,return_due_at,created_at,updated_at from mobility_allocations where case_id=$1 order by created_at desc`, [caseId]),
        client.query(`select id,approval_type,state,amount_minor,currency,decided_at,created_at from case_approvals where case_id=$1 order by created_at desc`, [caseId])
      ]);
      return { ok: true, projection: 'customer', case: c, vehicle, servicePlan: plan, transport: transport.rows, mobility: mobility.rows, approvals: approvals.rows };
    }

    if (principal.role === 'tow') {
      const transport = await client.query(`select id,transport_type,status,pickup_location,dropoff_location,vehicle_context,eta_at,external_reference,metadata,created_at,updated_at from transport_dispatches where case_id=$1 and provider_actor_id=$2 order by created_at desc`, [caseId, principal.actorId]);
      return { ok: true, projection: 'tow', case: { id:c.id,state:c.state,drivability:c.drivability,priority:c.priority }, vehicle, transport: transport.rows };
    }

    if (principal.role === 'parts') {
      const orders = await client.query(`select * from parts_orders where case_id=$1 and supplier_actor_id=$2 order by created_at desc`, [caseId, principal.actorId]);
      const orderIds = orders.rows.map((x) => x.id);
      const items = orderIds.length ? await client.query(`select * from parts_order_items where order_id = any($1::uuid[]) order by created_at`, [orderIds]) : { rows: [] };
      return { ok: true, projection: 'parts', case: { id:c.id,state:c.state,priority:c.priority }, vehicle, orders: orders.rows, items: items.rows };
    }

    if (principal.role === 'fleet') {
      const allocations = await client.query(`select * from mobility_allocations where case_id=$1 and provider_actor_id=$2 order by created_at desc`, [caseId, principal.actorId]);
      return { ok: true, projection: 'mobility', case: { id:c.id,state:c.state,priority:c.priority }, allocations: allocations.rows };
    }

    if (principal.role === 'diagnostic') {
      const findings = await client.query(`select * from diagnostic_findings where case_id=$1 and diagnostic_actor_id=$2 order by created_at desc`, [caseId, principal.actorId]);
      const tasks = plan ? await client.query(`select id,task_type,sequence,status,title,instructions,due_at,metadata from service_plan_tasks where service_plan_id=$1 and assigned_actor_id=$2 order by revision desc,sequence asc`, [plan.id, principal.actorId]) : { rows: [] };
      return { ok: true, projection: 'diagnostic', case: c, vehicle, servicePlan: plan, diagnostics: findings.rows, tasks: tasks.rows };
    }

    if (principal.role === 'partner') {
      const [commitments, tasks] = await Promise.all([
        client.query(`select id,commitment_type,state,terms,created_at,updated_at from case_commitments where case_id=$1 and provider_actor_id=$2 order by created_at desc`, [caseId, principal.actorId]),
        plan ? client.query(`select id,task_type,sequence,status,title,instructions,due_at,estimated_amount_minor,currency,metadata from service_plan_tasks where service_plan_id=$1 and assigned_actor_id=$2 order by revision desc,sequence asc`, [plan.id, principal.actorId]) : Promise.resolve({ rows: [] })
      ]);
      return { ok: true, projection: 'partner', case: c, vehicle, servicePlan: plan, commitments: commitments.rows, tasks: tasks.rows };
    }

    const [events, commitments, transport, diagnostics, parts, mobility, approvals, quotes, exceptions] = await Promise.all([
      client.query(`select * from events where aggregate_type='service_case' and aggregate_id=$1 order by occurred_at`, [caseId]),
      client.query(`select * from case_commitments where case_id=$1 order by created_at`, [caseId]),
      client.query(`select * from transport_dispatches where case_id=$1 order by created_at`, [caseId]),
      client.query(`select * from diagnostic_findings where case_id=$1 order by created_at`, [caseId]),
      client.query(`select * from parts_orders where case_id=$1 order by created_at`, [caseId]),
      client.query(`select * from mobility_allocations where case_id=$1 order by created_at`, [caseId]),
      client.query(`select * from case_approvals where case_id=$1 order by created_at`, [caseId]),
      client.query(`select * from service_quotes where case_id=$1 order by created_at`, [caseId]),
      client.query(`select * from case_exceptions where case_id=$1 order by created_at`, [caseId])
    ]);
    return { ok: true, projection: 'admin', case: c, vehicle, servicePlan: plan, commitments: commitments.rows, transport: transport.rows, diagnostics: diagnostics.rows, parts: parts.rows, mobility: mobility.rows, approvals: approvals.rows, quotes: quotes.rows, exceptions: exceptions.rows, events: events.rows };
  });
}

function requireInternalAuth(request, env) {
  const secret = env.ROVIQ_E2E_TOKEN;
  if (!secret) throw new Error('internal_auth_not_configured');
  const auth = request.headers.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(String(secret));
  const b = Buffer.from(String(supplied));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('unauthorized');
}

async function e2eAuthProjection(request, env) {
  requireInternalAuth(request, env);
  return await withClient(env, async (client) => {
    const latest = await client.query(`select id from service_cases order by created_at desc limit 1`);
    if (!latest.rowCount) throw new Error('case_not_found');
    const caseId = latest.rows[0].id;
    const token = await issueAccessToken(env, '00000000-0000-0000-0000-000000000001', 'admin', null);
    const synthetic = new Request(`https://internal/api/maintenance/cases/${caseId}/projection`, { headers: { authorization: `Bearer ${token}` } });
    const principal = await principalFromRequest(synthetic, env);
    const projected = await caseProjection(env, principal, caseId);
    return { ok: true, jwtVerified: true, role: principal.role, caseId, projection: projected.projection };
  });
}

function errorResponse(error) {
  const message = String(error?.message || error);
  if (message === 'unauthorized' || message === 'invalid_credentials') return json({ ok:false,error:message }, 401);
  if (message === 'forbidden') return json({ ok:false,error:message }, 403);
  if (message === 'case_not_found') return json({ ok:false,error:message }, 404);
  if (['content_type_must_be_application_json','credentials_required'].includes(message)) return json({ ok:false,error:message }, 400);
  return json({ ok:false,error:message }, 503);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/auth/login' && request.method === 'POST') return json(await login(env, await readJson(request)));
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const principal = await principalFromRequest(request, env);
        return json({ ok:true, principal });
      }
      const projectionMatch = url.pathname.match(/^\/api\/maintenance\/cases\/([0-9a-f-]+)\/projection$/i);
      if (projectionMatch && request.method === 'GET') {
        const principal = await principalFromRequest(request, env);
        return json(await caseProjection(env, principal, projectionMatch[1]));
      }
      if (url.pathname === '/api/internal/e2e/auth-projection' && request.method === 'POST') return json(await e2eAuthProjection(request, env), 201);
      return await productionWorker.fetch(request, env, ctx);
    } catch (error) { return errorResponse(error); }
  }
};
