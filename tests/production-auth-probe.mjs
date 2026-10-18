import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { EDGE_URL, PORTALS } from './production-config.mjs';

const CUSTOMER_URL = PORTALS.customer;
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

async function gotoStable(page, url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (response && response.status() >= 400) throw new Error(`GET ${url} -> ${response.status()}`);
      await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await page.waitForTimeout(1500 * attempt);
    }
  }
  throw lastError;
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

  await gotoStable(page, `${CUSTOMER_URL}/login`);
  await page.locator('#email').fill(ADMIN_EMAIL);
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('alert').filter({hasText:'requires a granted customer account'}).waitFor({timeout:15000});
  const rejected = await page.evaluate(() => ({token:localStorage.getItem('roviq_access_token'),principal:localStorage.getItem('roviq_principal')}));
  assert.equal(rejected.token,null,'Admin-only login must not persist a Customer token');
  assert.equal(rejected.principal,null,'Admin-only login must not become Customer');
  assert.ok(authResponses.every(r=>!r.url.includes('/testing/')),'Normal Customer login must not create testing identities');

  // The probe explicitly obtained this scoped test fixture above. Normal app sign-in never does so.
  await page.evaluate(session=>{
    localStorage.setItem('roviq_access_token',session.accessToken);
    localStorage.setItem('roviq_principal',JSON.stringify(session.principal));
  },customerSession.body);
  await gotoStable(page,`${CUSTOMER_URL}/`);
  assert.ok(!new URL(page.url()).pathname.endsWith('/login'),'Explicit scoped Customer fixture could not open Customer');
  await page.screenshot({path:path.join(ARTIFACT_DIR,'customer-auth-probe.png'),fullPage:true}).catch(()=>{});
  await context.close();
} finally {
  await browser.close();
}

console.log('[auth-probe] Customer boundary passed: admin-only UI login rejected; explicitly provisioned Customer fixture opens Customer.');
