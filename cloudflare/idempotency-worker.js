import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from 'pg';
import operationsWorker from './operations-worker.js';

const MUTATING = new Set(['POST','PUT','PATCH','DELETE']);
const EXEMPT_PREFIXES = ['/api/auth/','/api/internal/e2e/'];
const IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

async function withClient(env, fn) {
  if (!env.HYPERDRIVE?.connectionString) throw new Error('hyperdrive_binding_missing');
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end().catch(() => undefined); }
}

function shouldProtect(request, url) {
  if (!MUTATING.has(request.method)) return false;
  if (!url.pathname.startsWith('/api/')) return false;
  return !EXEMPT_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function requestFingerprint(request, url, bodyText) {
  const auth = request.headers.get('authorization') || '';
  return createHash('sha256')
    .update(`${request.method}\n${url.pathname}\n${url.search}\n${auth}\n${bodyText}`)
    .digest('hex');
}

function ledgerKey(request, url, rawKey) {
  const auth = request.headers.get('authorization') || '';
  const principalHash = createHash('sha256').update(auth).digest('hex').slice(0, 24);
  const routeHash = createHash('sha256').update(`${request.method}:${url.pathname}`).digest('hex').slice(0, 24);
  return `core:${principalHash}:${routeHash}:${rawKey}`;
}

async function maintenanceDomainId(client) {
  const result = await client.query(`select id from domains where code='maintenance' limit 1`);
  if (!result.rowCount) throw new Error('maintenance_domain_missing');
  return result.rows[0].id;
}

async function reserve(env, key, fingerprint, route) {
  return await withClient(env, async (client) => {
    await client.query('begin');
    try {
      const domainId = await maintenanceDomainId(client);
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [key]);
      const existing = await client.query(`select * from transactions where idempotency_key=$1 limit 1`, [key]);
      let result;
      if (existing.rowCount) {
        const row = existing.rows[0];
        const terms = row.terms || {};
        if (terms.fingerprint && terms.fingerprint !== fingerprint) result = { type: 'conflict' };
        else if (row.state === 'completed' && terms.response) result = { type: 'replay', response: terms.response };
        else {
          const age = Date.now() - new Date(row.updated_at || row.created_at).getTime();
          if (row.state === 'processing' && age < IDEMPOTENCY_TTL_MS) result = { type: 'processing' };
          else {
            await client.query(
              `update transactions set state='processing',terms=$1::jsonb,updated_at=now() where id=$2`,
              [JSON.stringify({ fingerprint, route, startedAt: new Date().toISOString() }), row.id]
            );
            result = { type: 'reserved', id: row.id };
          }
        }
      } else {
        const inserted = await client.query(
          `insert into transactions(domain_id,transaction_type,state,idempotency_key,terms)
           values($1,'idempotency','processing',$2,$3::jsonb) returning id`,
          [domainId, key, JSON.stringify({ fingerprint, route, startedAt: new Date().toISOString() })]
        );
        result = { type: 'reserved', id: inserted.rows[0].id };
      }
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    }
  });
}

async function complete(env, id, fingerprint, route, response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (['content-type','location','etag'].includes(name.toLowerCase())) headers[name] = value;
  });
  const body = await response.text();
  const stored = { status: response.status, headers, body };
  await withClient(env, (client) => client.query(
    `update transactions set state='completed',terms=$1::jsonb,updated_at=now() where id=$2`,
    [JSON.stringify({ fingerprint, route, completedAt: new Date().toISOString(), response: stored }), id]
  ));
  return new Response(body, { status: response.status, headers: response.headers });
}

async function release(env, id, error) {
  await withClient(env, (client) => client.query(
    `update transactions set state='failed',terms=terms || $1::jsonb,updated_at=now() where id=$2`,
    [JSON.stringify({ failedAt: new Date().toISOString(), error: String(error?.message || error).slice(0, 500) }), id]
  )).catch(() => undefined);
}

function replay(stored) {
  return new Response(stored.body || '', {
    status: Number(stored.status || 200),
    headers: { ...(stored.headers || {}), 'idempotency-replayed': 'true', 'cache-control': 'no-store' }
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

async function runIdempotencySelfTest(request, env) {
  requireInternalAuth(request, env);
  const raw = `e2e-${crypto.randomUUID()}`;
  const key = `core:e2e:selftest:${raw}`;
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  const first = await reserve(env, key, fingerprint, '/api/internal/e2e/idempotency');
  if (first.type !== 'reserved') throw new Error(`first_reservation_${first.type}`);
  await complete(env, first.id, fingerprint, '/api/internal/e2e/idempotency', json({ ok: true, marker: raw }, 201));
  const second = await reserve(env, key, fingerprint, '/api/internal/e2e/idempotency');
  if (second.type !== 'replay') throw new Error(`second_reservation_${second.type}`);
  const replayBody = JSON.parse(second.response.body || '{}');
  return json({ ok: true, first: 'created', second: 'replayed', sameMarker: replayBody.marker === raw }, 200);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/internal/e2e/auth-check' && request.method === 'GET') {
      try {
        requireInternalAuth(request, env);
        return json({ ok: true, internalAuth: 'ready' });
      } catch (error) {
        const message = String(error?.message || error);
        return json({ ok: false, error: message }, message === 'unauthorized' ? 401 : 503);
      }
    }

    if (url.pathname === '/api/internal/e2e/idempotency' && request.method === 'POST') {
      try { return await runIdempotencySelfTest(request, env); }
      catch (error) { return json({ ok: false, error: String(error?.message || error) }, 503); }
    }

    if (!shouldProtect(request, url)) return operationsWorker.fetch(request, env, ctx);

    const rawKey = (request.headers.get('idempotency-key') || '').trim();
    if (!rawKey) return json({ ok: false, error: 'idempotency_key_required' }, 400);
    if (rawKey.length > 200) return json({ ok: false, error: 'idempotency_key_too_long' }, 400);

    const bodyText = await request.clone().text();
    const fingerprint = requestFingerprint(request, url, bodyText);
    const key = ledgerKey(request, url, rawKey);
    const route = `${request.method} ${url.pathname}`;

    const reservation = await reserve(env, key, fingerprint, route);
    if (reservation.type === 'conflict') return json({ ok: false, error: 'idempotency_key_reused_with_different_request' }, 409);
    if (reservation.type === 'processing') return json({ ok: false, error: 'idempotency_request_in_progress' }, 409, { 'retry-after': '2' });
    if (reservation.type === 'replay') return replay(reservation.response);

    try {
      const downstream = await operationsWorker.fetch(request, env, ctx);
      if (downstream.status >= 500) {
        await release(env, reservation.id, `downstream_${downstream.status}`);
        return downstream;
      }
      return await complete(env, reservation.id, fingerprint, route, downstream);
    } catch (error) {
      await release(env, reservation.id, error);
      throw error;
    }
  }
};
