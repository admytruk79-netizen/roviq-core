import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { beforeEach, test } from 'node:test';

// Run the actual session module without external dependencies. Replace only
// Vite's build-time environment access; Node strips the TypeScript types.
const source = (await readFile(new URL('../service/src/session.ts', import.meta.url), 'utf8'))
  .replace('import.meta.env.VITE_API_BASE_URL', 'undefined');
const javascript = stripTypeScriptTypes(source, { mode: 'transform' });
const { signIn, restoreSession } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const values = new Map();
const token = role => `header.${btoa(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
const session = role => ({ accessToken: token(role), principal: { role, actorId: `${role}-actor` } });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  values.clear();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
});

test('failed role handoff removes previously prepared workspace tokens', async () => {
  globalThis.fetch = async url => url.endsWith('/api/auth/login')
    ? response({ ...session('diagnostic'), roles: [{ role: 'diagnostic' }, { role: 'parts' }] })
    : response({ error: 'role_revoked' }, 403);
  await assert.rejects(signIn('test@example.com', 'password'), /role_revoked/);
  assert.equal(restoreSession(), null);
  assert.equal(values.size, 0);
});

test('unexpected scoped principal is rejected and all tokens are cleared', async () => {
  globalThis.fetch = async url => url.endsWith('/api/auth/login')
    ? response({ ...session('diagnostic'), roles: [{ role: 'diagnostic' }, { role: 'parts' }] })
    : response(session('admin'));
  await assert.rejects(signIn('test@example.com', 'password'), /invalid_workspace_session/);
  assert.equal(values.size, 0);
});

test('missing actor binding is rejected', async () => {
  globalThis.fetch = async () => response({ accessToken: token('partner'), principal: { role: 'partner' } });
  await assert.rejects(signIn('test@example.com', 'password'), /invalid_workspace_session/);
  assert.equal(values.size, 0);
});

test('successful multi-role login retains separate scoped sessions', async () => {
  globalThis.fetch = async url => url.endsWith('/api/auth/login')
    ? response({ ...session('diagnostic'), roles: [{ role: 'diagnostic' }, { role: 'parts' }] })
    : response(session('parts'));
  assert.deepEqual((await signIn('test@example.com', 'password')).roles, ['diagnostic', 'parts']);
  assert.deepEqual(restoreSession().roles, ['diagnostic', 'parts']);
  assert.equal(values.get('roviq_diagnostic_token'), token('diagnostic'));
  assert.equal(values.get('roviq_parts_token'), token('parts'));
});
