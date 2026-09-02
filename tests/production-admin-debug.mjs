import assert from 'node:assert/strict';

const EDGE_URL = process.env.EDGE_URL ?? 'https://roviq-core.admytruk79.workers.dev';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const CASE_ID = process.env.DEBUG_CASE_ID?.trim() ?? '';
const TO_STATE = process.env.DEBUG_TO_STATE?.trim() ?? 'repair_in_progress';

assert.ok(ADMIN_EMAIL && ADMIN_PASSWORD, 'ADMIN_EMAIL / ADMIN_PASSWORD are required');
assert.ok(CASE_ID, 'DEBUG_CASE_ID is required');

const login = await fetch(`${EDGE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
});
const loginBody = await login.json();
assert.equal(login.status, 200, `admin login failed: ${JSON.stringify(loginBody)}`);

const debugRes = await fetch(`${EDGE_URL}/api/admin/debug/replay-transition`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${loginBody.accessToken}` },
  body: JSON.stringify({ caseId: CASE_ID, toState: TO_STATE })
});
const debugBody = await debugRes.text();
console.log(`[admin-debug] POST /api/admin/debug/replay-transition -> ${debugRes.status}`);
console.log(debugBody);
