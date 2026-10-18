import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = (await readFile(new URL('../src/services/integration-gateway.ts', import.meta.url), 'utf8'))
  .replace("import { pool } from '../db/pool.js';", 'const pool = { connect: (...args) => globalThis.simulationPool.connect(...args), query: (...args) => globalThis.simulationPool.query(...args) };')
  .replace("import { audit } from './audit.js';", 'const audit = async () => {};');
const gateway = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64')}`);
function setup(attempt = 0) {
  const delivery = { id: 'delivery', integration_event_id: 'event', endpoint_url: 'https://mock.invalid/webhook',
    secret: 'simulation-only-secret', event_type: 'case.updated', aggregate_type: 'service_case',
    aggregate_id: 'case', actor_id: 'shop', payload: { simulated: true }, occurred_at: new Date().toISOString(), attempt_count: attempt };
  const state = { status: 'pending', updates: [], requests: [] };
  const pool = { async connect() { return { query: pool.query, release() {} }; }, async query(raw, params = []) {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] };
    if (sql.startsWith('select d.*')) return { rows: state.status === 'delivered' || state.status === 'dead' ? [] : [{ ...delivery }] };
    if (sql.includes("set state='processing'")) state.status = 'processing';
    else if (sql.includes("set state='delivered'")) { state.status = 'delivered'; delivery.attempt_count++; }
    else if (sql.includes('set state=$1')) { state.status = params[0]; delivery.attempt_count = params[1]; }
    else throw new Error(`Unknown gateway query: ${sql}`);
    state.updates.push({ sql, params }); return { rows: [] };
  } };
  globalThis.simulationPool = pool;
  return { state, delivery };
}

test('signed case webhook retries a 503 with the same event ID and payload', async () => {
  const { state, delivery } = setup();
  globalThis.fetch = async (_url, init) => {
    state.requests.push(init);
    const expected = createHmac('sha256', delivery.secret).update(`${init.headers['x-roviq-timestamp']}.${init.body}`).digest('hex');
    assert.equal(init.headers['x-roviq-signature'], `v1=${expected}`);
    return new Response('', { status: state.requests.length === 1 ? 503 : 200 });
  };
  assert.equal((await gateway.deliverWebhookBatch())[0].state, 'retry');
  assert.equal(state.status, 'retry');
  const retry = state.updates.find(u => u.params[0] === 'retry');
  assert.ok(Number(retry.params[3]) > 0, 'retry must schedule positive backoff');
  // The mock makes the retry due immediately; actual scheduler timing is not emulated.
  assert.equal((await gateway.deliverWebhookBatch())[0].state, 'delivered');
  assert.equal(state.requests[0].headers['x-roviq-event-id'], state.requests[1].headers['x-roviq-event-id']);
  assert.equal(state.requests[0].body, state.requests[1].body);
  assert.equal((await gateway.deliverWebhookBatch()).length, 0);
});

test('unreachable provider at the last attempt becomes dead-lettered', async () => {
  const { state } = setup(7);
  globalThis.fetch = async () => { throw new Error('simulated_connection_timeout'); };
  assert.equal((await gateway.deliverWebhookBatch())[0].state, 'dead');
  assert.equal(state.status, 'dead');
  assert.equal((await gateway.deliverWebhookBatch()).length, 0);
});

test('timeout after provider acceptance requires receiver deduplication', async () => {
  const { state } = setup();
  const receiverEvents = new Set();
  let effects = 0;
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    attempts++;
    const eventId = init.headers['x-roviq-event-id'];
    if (!receiverEvents.has(eventId)) { receiverEvents.add(eventId); effects++; }
    if (attempts === 1) throw new Error('simulated_response_lost_after_acceptance');
    return new Response('', { status: 200 });
  };
  await gateway.deliverWebhookBatch();
  assert.equal(state.status, 'retry');
  await gateway.deliverWebhookBatch();
  assert.equal(attempts, 2);
  assert.equal(effects, 1);
  assert.equal(state.status, 'delivered');
  // Receiver deduplication is mocked, not a guarantee imposed by this sender.
});
