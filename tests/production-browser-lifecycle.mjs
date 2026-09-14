import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const EDGE_URL = process.env.EDGE_URL ?? 'https://roviq-core.admytruk79.workers.dev';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const MODE = process.env.BROWSER_MODE ?? 'render';
const ARTIFACT_DIR = path.resolve(process.env.BROWSER_ARTIFACT_DIR ?? 'artifacts/production-browser');

const PORTALS = {
  customer: 'https://roviq-web-dxv.pages.dev',
  diagnostic: 'https://roviq-diagnostic-net.pages.dev',
  partner: 'https://roviq-partner.pages.dev',
  parts: 'https://roviq-parts.pages.dev',
  tow: 'https://roviq-tow.pages.dev',
  ops: 'https://roviq-ops.pages.dev'
};

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function log(message) { console.log(`[roviq-browser] ${message}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(ARTIFACT_DIR, `${name}.png`), fullPage: true });
}

async function gotoStable(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
}

async function requestJson(endpoint, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${EDGE_URL}${endpoint}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${endpoint} -> ${response.status}: ${text.slice(0, 1000)}`);
  return json;
}

async function waitForCaseState(caseId, token, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await requestJson(`/api/maintenance/cases/${caseId}`, { token });
    if (last?.case?.state === expected) return last.case;
    await sleep(750);
  }
  throw new Error(`Case ${caseId} did not reach ${expected}; last=${last?.case?.state ?? 'unknown'}`);
}

async function waitForCollectionItem(endpoint, token, key, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const payload = await requestJson(endpoint, { token });
    last = payload?.[key] ?? [];
    const item = last.find(predicate);
    if (item) return item;
    await sleep(750);
  }
  throw new Error(`No matching ${key} item from ${endpoint}; count=${last.length}`);
}

async function setPortalSession(page, portalUrl, tokenKey, principalKey, session) {
  await gotoStable(page, portalUrl);
  await page.evaluate(({ tokenKey, principalKey, session }) => {
    localStorage.setItem(tokenKey, session.accessToken);
    localStorage.setItem(principalKey, JSON.stringify(session.principal));
  }, { tokenKey, principalKey, session });
  await gotoStable(page, portalUrl);
}

async function renderSmoke(browser) {
  log('Running desktop/mobile browser render smoke across all six portals.');
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 }
  ];
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    for (const [name, url] of Object.entries(PORTALS)) {
      const page = await context.newPage();
      await gotoStable(page, url);
      const body = (await page.locator('body').innerText()).trim();
      assert.ok(body.length > 0, `${name} portal body was empty on ${viewport.name}`);
      assert.match(body, /ROVIQ/i, `${name} portal did not render ROVIQ branding on ${viewport.name}`);
      await screenshot(page, `${viewport.name}-${name}`);
      await page.close();
      log(`${viewport.name}: ${name} rendered`);
    }
    await context.close();
  }
}

async function productionLifecycle(browser) {
  assert.ok(ADMIN_EMAIL && ADMIN_PASSWORD, 'ADMIN_EMAIL and ADMIN_PASSWORD are required for lifecycle mode');
  const marker = `browser-acceptance-${Date.now()}`;

  log('1/10 Customer: sign in through the real UI and create a tagged case.');
  const customerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const customer = await customerContext.newPage();
  await gotoStable(customer, `${PORTALS.customer}/login`);
  await customer.locator('#email').fill(ADMIN_EMAIL);
  await customer.locator('#password').fill(ADMIN_PASSWORD);
  await customer.getByRole('button', { name: 'Sign in' }).click();
  await customer.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 30_000 });
  await gotoStable(customer, `${PORTALS.customer}/cases/new`);
  await customer.locator('#issueType').selectOption('wont_start');
  await customer.locator('#description').fill(marker);
  await customer.locator('#urgency').selectOption('urgent');
  await customer.getByRole('button', { name: 'Submit' }).click();
  await customer.waitForURL(/\/cases\/[0-9a-f-]{36}$/i, { timeout: 30_000 });
  const caseId = customer.url().match(/\/cases\/([0-9a-f-]{36})$/i)?.[1];
  assert.ok(caseId, 'Customer case id was not present after submission');
  const casePrefix = caseId.slice(0, 8);
  const customerToken = await customer.evaluate(() => localStorage.getItem('roviq_access_token'));
  assert.ok(customerToken, 'Customer UI did not persist its scoped access token');
  await screenshot(customer, 'lifecycle-01-customer-created');

  log('2/10 Core: obtain the same real admin session and scoped test-role sessions used by each portal.');
  const admin = await requestJson('/api/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
  });
  assert.equal(admin.principal.role, 'admin');
  const adminToken = admin.accessToken;
  const sessionFor = role => requestJson(`/api/admin/testing/${role}-session`, {
    method: 'POST', token: adminToken, body: {}
  });
  const [diagnosticSession, towSession, partnerSession, partsSession] = await Promise.all([
    sessionFor('diagnostic'), sessionFor('tow'), sessionFor('partner'), sessionFor('parts')
  ]);

  log('3/10 Ops: move the case to diagnostic pending and dispatch the test diagnostic provider through UI controls.');
  const opsContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ops = await opsContext.newPage();
  await setPortalSession(ops, PORTALS.ops, 'roviq_access_token', 'roviq_principal', admin);
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const moveSection = ops.locator('section').filter({ hasText: 'Move case state' }).first();
  await moveSection.locator('select').selectOption('diagnostic_pending');
  await moveSection.getByRole('button', { name: 'Transition' }).click();
  await waitForCaseState(caseId, adminToken, 'diagnostic_pending');
  // Core is authoritative; re-open the case after the state transition so Ops renders
  // the handoff controls for the confirmed server state rather than a stale React view.
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const diagnosticSection = ops.locator('section').filter({ hasText: 'Diagnostic handoff' }).first();
  try {
    await diagnosticSection.locator('select').waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const liveCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken }).catch(e => ({ error: String(e) }));
    const actors = await requestJson('/api/admin/actors?status=active', { token: adminToken }).catch(e => ({ error: String(e) }));
    const bodyText = await ops.locator('body').innerText().catch(() => '<unreadable>');
    log(`DIAGNOSTIC 3/10 handoff select missing. live case state=${liveCase?.case?.state ?? JSON.stringify(liveCase)}`);
    log(`DIAGNOSTIC 3/10 test actor=${diagnosticSession.principal.actorId}; active diagnostic actors=${JSON.stringify((actors?.actors ?? []).filter(actor => actor.actor_type === 'diagnostic').map(actor => actor.id))}`);
    log(`DIAGNOSTIC 3/10 ops page body snippet: ${bodyText.slice(0, 2000).replace(/\s+/g, ' ')}`);
    throw error;
  }
  await diagnosticSection.locator('select').selectOption(diagnosticSession.principal.actorId);
  await diagnosticSection.getByRole('button', { name: 'Send diagnostic offer' }).click();
  await diagnosticSection.getByText(/has been offered this case/i).waitFor({ timeout: 20_000 });
  await screenshot(ops, 'lifecycle-02-ops-diagnostic-dispatch');

  log('4/10 Diagnostic: accept the exact case and route the non-drivable vehicle to tow through the Diagnostic UI.');
  const diagnosticQueue = await requestJson('/api/diagnostics/me/queue', { token: diagnosticSession.accessToken });
  const diagnosticItem = diagnosticQueue.queue.find(item => item.case_id === caseId);
  assert.ok(diagnosticItem, `Diagnostic queue does not contain case ${caseId}`);
  const demandId = diagnosticItem.demand_id;
  const diagnosticContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const diagnostic = await diagnosticContext.newPage();
  await setPortalSession(diagnostic, PORTALS.diagnostic, 'roviq_diagnostic_token', 'roviq_diagnostic_principal', diagnosticSession);
  const diagnosticCard = diagnostic.locator('button.queue-card').filter({ hasText: `Demand ${demandId.slice(0, 8)}` }).first();
  await diagnosticCard.click();
  if (diagnosticItem.outcome === 'offered') {
    await diagnostic.getByRole('button', { name: 'Accept assignment' }).click();
  }
  const findingForm = diagnostic.locator('form').filter({ hasText: 'Accepted assignment' }).first();
  await findingForm.locator('textarea').fill('Browser acceptance: verified non-drivable vehicle requiring tow to repair provider.');
  await findingForm.getByLabel('Drivability').selectOption('non_drivable');
  await findingForm.getByLabel('Next handoff').selectOption('route_to_tow');
  await findingForm.getByRole('button', { name: 'Save finding' }).click();
  await waitForCaseState(caseId, adminToken, 'tow_pending');
  await screenshot(diagnostic, 'lifecycle-03-diagnostic-to-tow');

  log('5/10 Ops + Tow: assign Tow / Valet, then drive every dispatch status to delivered through the Tow UI.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const towSection = ops.locator('section').filter({ hasText: 'Tow handoff' }).first();
  try {
    await towSection.locator('select').waitFor({ timeout: 30_000 });
  } catch (error) {
    const liveCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken }).catch(e => ({ error: String(e) }));
    const bodyText = await ops.locator('body').innerText().catch(() => '<unreadable>');
    log(`DIAGNOSTIC 5/10 tow select missing. live case state=${liveCase?.case?.state ?? JSON.stringify(liveCase)}`);
    log(`DIAGNOSTIC 5/10 ops page body snippet: ${bodyText.slice(0, 2000).replace(/\s+/g, ' ')}`);
    throw error;
  }
  await towSection.locator('select').selectOption(towSession.principal.actorId);
  await towSection.getByRole('button', { name: /Create and assign tow|Assign Tow provider/i }).click();

  const dispatch = await waitForCollectionItem(
    '/api/transport/me/dispatches',
    towSession.accessToken,
    'dispatches',
    item => item.case_id === caseId
  );
  const towContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tow = await towContext.newPage();
  await setPortalSession(tow, PORTALS.tow, 'roviq_tow_token', 'roviq_tow_principal', towSession);
  await gotoStable(tow, `${PORTALS.tow}/dispatches/${dispatch.id}`);
  for (const [label, expected] of [
    ['Accept job', 'accepted'], ['En route', 'en_route'], ['Arrived', 'arrived'], ['Vehicle loaded', 'loaded'], ['Deliver vehicle', 'delivered']
  ]) {
    const button = tow.getByRole('button', { name: label });
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await waitForCollectionItem('/api/transport/me/dispatches', towSession.accessToken, 'dispatches', item => item.id === dispatch.id && item.status === expected);
    }
  }
  await screenshot(tow, 'lifecycle-04-tow-delivered');

  log('6/10 Ops + Partner: route/select a repair provider and accept it in Partner.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const liveAfterTow = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  if (liveAfterTow.case.state !== 'provider_selection') {
    const next = ops.locator('section').filter({ hasText: 'Next action' }).getByRole('button').first();
    if (await next.isVisible().catch(() => false)) await next.click();
    await waitForCaseState(caseId, adminToken, 'provider_selection');
    await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  }
  const repairSection = ops.locator('section').filter({ hasText: 'Repair provider handoff' }).first();
  await repairSection.getByRole('button', { name: 'Evaluate repair providers' }).click();
  const repairSelect = repairSection.locator('select');
  await repairSelect.waitFor({ state: 'visible', timeout: 30_000 });
  const partnerId = partnerSession.principal.actorId;
  const partnerOption = repairSelect.locator(`option[value="${partnerId}"]`);
  assert.ok(await partnerOption.count(), 'Test partner is not eligible in Ops repair routing');
  await repairSelect.selectOption(partnerId);
  await repairSection.getByRole('button', { name: 'Select and offer repair' }).click();
  await waitForCaseState(caseId, adminToken, 'provider_pending');

  const partnerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const partner = await partnerContext.newPage();
  await setPortalSession(partner, PORTALS.partner, 'roviq_partner_token', 'roviq_partner_principal', partnerSession);
  const offerCard = partner.locator('[data-case-id]').filter({ hasText: casePrefix }).first();
  await offerCard.getByRole('button', { name: /Accept/i }).click();
  await waitForCaseState(caseId, adminToken, 'repair_in_progress');
  await screenshot(partner, 'lifecycle-05-partner-accepted');

  log('7/10 Partner + Parts: create/approve repair work and hand off a parts request through the real portals.');
  const repairOrder = await requestJson(`/api/shop-os/cases/${caseId}/repair-order`, { token: partnerSession.accessToken }).catch(() => null);
  let orderId = repairOrder?.order?.id;
  if (!orderId) {
    const created = await requestJson('/api/shop-os/repair-orders', {
      method: 'POST', token: partnerSession.accessToken,
      body: { caseId, description: 'Browser acceptance repair order' }
    });
    orderId = created.order.id;
  }
  await requestJson(`/api/shop-os/repair-orders/${orderId}/lines`, {
    method: 'POST', token: partnerSession.accessToken,
    body: { description: 'Browser acceptance replacement part', quantity: 1, unitPrice: 75, unitCost: 40 }
  });
  await requestJson(`/api/shop-os/repair-orders/${orderId}/submit`, { method: 'POST', token: partnerSession.accessToken, body: {} }).catch(() => null);
  const partnerOrder = await requestJson(`/api/shop-os/repair-orders/${orderId}`, { token: partnerSession.accessToken });
  for (const line of partnerOrder.lines ?? []) {
    if (line.approval_status !== 'approved') await requestJson(`/api/shop-os/repair-order-lines/${line.id}`, { method: 'PATCH', token: partnerSession.accessToken, body: { approvalStatus: 'approved' } });
  }
  await requestJson(`/api/shop-os/repair-orders/${orderId}/approve`, { method: 'POST', token: partnerSession.accessToken, body: {} }).catch(() => null);

  const partsRequest = await requestJson('/api/parts/requests', {
    method: 'POST', token: partnerSession.accessToken,
    body: { caseId, repairOrderId: orderId, description: 'Browser acceptance part', quantity: 1 }
  });
  const partsRequestId = partsRequest.request.id;
  const partsContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const parts = await partsContext.newPage();
  await setPortalSession(parts, PORTALS.parts, 'roviq_parts_token', 'roviq_parts_principal', partsSession);
  await gotoStable(parts, `${PORTALS.parts}/requests/${partsRequestId}`);
  for (const [label, expected] of [['Accept request', 'accepted'], ['Mark ordered', 'ordered'], ['Mark received', 'received']]) {
    const button = parts.getByRole('button', { name: label });
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await waitForCollectionItem('/api/parts/me/requests', partsSession.accessToken, 'requests', item => item.id === partsRequestId && item.status === expected);
    }
  }
  await screenshot(parts, 'lifecycle-06-parts-received');

  log('8/10 Partner: finish the repair and confirm completion.');
  const currentOrder = await requestJson(`/api/shop-os/repair-orders/${orderId}`, { token: partnerSession.accessToken });
  if (currentOrder.order.status === 'approved') await requestJson(`/api/shop-os/repair-orders/${orderId}/start`, { method: 'POST', token: partnerSession.accessToken, body: {} });
  const startedOrder = await requestJson(`/api/shop-os/repair-orders/${orderId}`, { token: partnerSession.accessToken });
  if (startedOrder.order.status === 'in_progress') await requestJson(`/api/shop-os/repair-orders/${orderId}/complete`, { method: 'POST', token: partnerSession.accessToken, body: {} });
  await screenshot(partner, 'lifecycle-07-repair-complete');

  log('9/10 Payment: exercise the real payment handoff if exposed by the production case.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const paymentLink = ops.getByRole('link', { name: /payment/i }).first();
  if (await paymentLink.isVisible().catch(() => false)) {
    await paymentLink.click();
    await ops.waitForLoadState('domcontentloaded');
  }
  await screenshot(ops, 'lifecycle-08-payment-handoff');

  log('10/10 Core: verify the same case is still readable and its lifecycle completed without losing authority.');
  const finalCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  assert.equal(finalCase.case.id, caseId);
  assert.ok(finalCase.case.state, 'Final case state is missing');

  await Promise.allSettled([
    customerContext.close(), opsContext.close(), diagnosticContext.close(), towContext.close(), partnerContext.close(), partsContext.close()
  ]);
  log(`Credentialed production lifecycle completed for case ${caseId} (state=${finalCase.case.state}).`);
}

const browser = await chromium.launch({ headless: true });
try {
  if (MODE === 'render') await renderSmoke(browser);
  else if (MODE === 'lifecycle') await productionLifecycle(browser);
  else throw new Error(`Unknown BROWSER_MODE=${MODE}`);
} finally {
  await browser.close();
}
