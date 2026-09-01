import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const EDGE_URL = process.env.EDGE_URL ?? 'https://roviq-core.admytruk79.workers.dev';
const CUSTOMER_URL = 'https://roviq-web-dxv.pages.dev';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ARTIFACT_DIR = path.resolve(process.env.BROWSER_ARTIFACT_DIR ?? 'artifacts/production-browser');

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function safeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  if ('accessToken' in copy) copy.accessToken = '[redacted]';
  if ('token' in copy) copy.token = '[redacted]';
  return copy;
}

async function call(pathname, init = {}) {
  const response = await fetch(`${EDGE_URL}${pathname}`, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text || null; }
  console.log(`[auth-probe] ${init.method ?? 'GET'} ${pathname} -> ${response.status} ${JSON.stringify(safeBody(body))}`);
  return { response, body };
}

assert.ok(ADMIN_EMAIL && ADMIN_PASSWORD, 'ADMIN_EMAIL / ADMIN_PASSWORD are required');

const login = await call('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
});
assert.equal(login.response.status, 200, 'Direct admin login failed');
assert.equal(login.body?.principal?.role, 'admin', 'Direct login did not return admin principal');
assert.ok(login.body?.accessToken, 'Direct login did not return an access token');

const customerSession = await call('/api/admin/testing/customer-session', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${login.body.accessToken}`
  },
  body: '{}'
});
assert.equal(customerSession.response.status, 200, 'Customer session handoff failed');
assert.equal(customerSession.body?.principal?.role, 'customer', 'Customer handoff did not return customer principal');
assert.ok(customerSession.body?.principal?.actorId, 'Customer handoff principal is missing actorId');

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const authResponses = [];
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('/api/auth/login') && !url.includes('/api/admin/testing/customer-session')) return;
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    authResponses.push({ url: new URL(url).pathname, status: response.status(), body: safeBody(body) });
    console.log(`[auth-probe] browser ${new URL(url).pathname} -> ${response.status()} ${JSON.stringify(safeBody(body))}`);
  });

  await page.goto(`${CUSTOMER_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('#email').fill(ADMIN_EMAIL);
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  let navigated = true;
  try {
    await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 15_000 });
  } catch {
    navigated = false;
  }

  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'customer-auth-probe.png'), fullPage: true }).catch(() => {});
  const uiError = await page.locator('p').filter({ hasText: /invalid|unable|requires|expired|error/i }).allInnerTexts().catch(() => []);
  const stored = await page.evaluate(() => ({
    hasToken: !!localStorage.getItem('roviq_access_token'),
    principal: localStorage.getItem('roviq_principal')
  }));
  let principal = null;
  try { principal = stored.principal ? JSON.parse(stored.principal) : null; } catch { principal = null; }
  console.log(`[auth-probe] browser navigated=${navigated} url=${page.url()} hasToken=${stored.hasToken} principalRole=${principal?.role ?? 'none'} actorIdPresent=${!!principal?.actorId} uiError=${JSON.stringify(uiError)}`);
  console.log(`[auth-probe] browser authResponses=${JSON.stringify(authResponses)}`);

  assert.ok(navigated, `Customer UI remained on login. responses=${JSON.stringify(authResponses)} uiError=${JSON.stringify(uiError)}`);
  assert.equal(principal?.role, 'customer', 'Customer UI did not persist customer principal');
  assert.ok(principal?.actorId, 'Customer UI principal is missing actorId');
  assert.ok(stored.hasToken, 'Customer UI did not persist access token');
  await context.close();
} finally {
  await browser.close();
}

console.log('[auth-probe] Customer auth path passed: direct login, customer-session handoff, and browser redirect.');
