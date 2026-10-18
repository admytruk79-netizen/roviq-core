import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = (await readFile(new URL('../src/services/integration-gateway.ts', import.meta.url), 'utf8'))
  .replace("import { pool } from '../db/pool.js';", 'const pool = { query: (...args) => globalThis.accessTestDb.query(...args) };')
  .replace("import { audit } from './audit.js';", 'const audit = async () => {};');
const gateway = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64')}`);
const key = 'rvq_simulated_integration_key_for_tests';
const hash = value => createHash('sha256').update(value).digest('hex');
function setup(overrides = {}, invalidateDuringUpdate = false) {
  const client = { id: 'client', actor_id: 'shop', status: 'active', revoked_at: null,
    actor_status: 'active', key_hash: hash(key), scopes: ['read'], ...overrides };
  const calls = [];
  globalThis.accessTestDb = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('update')) return { rowCount: invalidateDuringUpdate ? 0 : 1, rows: invalidateDuringUpdate ? [] : [client] };
    return { rowCount: 1, rows: [client] };
  } };
  return calls;
}

test('valid integration key for an active actor authenticates', async () => {
  const calls = setup();
  assert.equal((await gateway.authenticateIntegrationKey(key)).id, 'client');
  assert.equal(calls.filter(c => c.sql.startsWith('update')).length, 1);
});
test('revoked key fails even when its client status remains active', async () => {
  const calls = setup({ revoked_at: new Date().toISOString() });
  assert.equal(await gateway.authenticateIntegrationKey(key), null);
  assert.equal(calls.filter(c => c.sql.startsWith('update')).length, 0);
});
test('disabled actor cannot authenticate through an integration key', async () => {
  const calls = setup({ actor_status: 'disabled' });
  assert.equal(await gateway.authenticateIntegrationKey(key), null);
  assert.equal(calls.filter(c => c.sql.startsWith('update')).length, 0);
});
test('missing actor and inactive client fail closed', async () => {
  for (const overrides of [{ actor_status: null }, { status: 'disabled' }]) {
    setup(overrides);
    assert.equal(await gateway.authenticateIntegrationKey(key), null);
  }
});
test('same-prefix tampered key never marks the client as used', async () => {
  const calls = setup();
  assert.equal(await gateway.authenticateIntegrationKey(`${key}tampered`), null);
  assert.equal(calls.filter(c => c.sql.startsWith('update')).length, 0);
});
test('revocation observed at guarded usage update rejects the request', async () => {
  setup({}, true);
  assert.equal(await gateway.authenticateIntegrationKey(key), null);
});
