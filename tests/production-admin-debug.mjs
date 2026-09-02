import assert from 'node:assert/strict';

const EDGE_URL = process.env.EDGE_URL ?? 'https://roviq-core.admytruk79.workers.dev';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const OFFER_ID = process.env.DEBUG_OFFER_ID?.trim() ?? '';

assert.ok(ADMIN_EMAIL && ADMIN_PASSWORD, 'ADMIN_EMAIL / ADMIN_PASSWORD are required');
assert.ok(OFFER_ID, 'DEBUG_OFFER_ID is required');

const login = await fetch(`${EDGE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
});
const loginBody = await login.json();
assert.equal(login.status, 200, `admin login failed: ${JSON.stringify(loginBody)}`);

const partnerSessionRes = await fetch(`${EDGE_URL}/api/admin/testing/partner-session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${loginBody.accessToken}` },
  body: '{}'
});
const partnerSession = await partnerSessionRes.json();
assert.equal(partnerSessionRes.status, 200, `partner-session failed: ${JSON.stringify(partnerSession)}`);
console.log(`[admin-debug] partner-session -> ${partnerSessionRes.status} actorId=${partnerSession.principal.actorId}`);

const respondRes = await fetch(`${EDGE_URL}/api/offers/${OFFER_ID}/respond`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${partnerSession.accessToken}` },
  body: JSON.stringify({ outcome: 'accepted' })
});
const respondBody = await respondRes.text();
console.log(`[admin-debug] POST /api/offers/${OFFER_ID}/respond -> ${respondRes.status}`);
console.log(respondBody);
