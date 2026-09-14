import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { EDGE_URL, PORTALS } from './production-config.mjs';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const MODE = process.env.BROWSER_MODE ?? 'render';
const ARTIFACT_DIR = path.resolve(process.env.BROWSER_ARTIFACT_DIR ?? 'artifacts/production-browser');

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function log(message) { console.log(`[roviq-browser] ${message}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(ARTIFACT_DIR, `${name}.png`), fullPage: true });
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
      log(`Navigation retry ${attempt + 1}/${attempts}: ${url} (${String(error?.message ?? error).slice(0, 180)})`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
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

async function waitForCustomerSession(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const token = localStorage.getItem('roviq_access_token');
      const rawPrincipal = localStorage.getItem('roviq_principal');
      let principal = null;
      try { principal = rawPrincipal ? JSON.parse(rawPrincipal) : null; } catch { principal = null; }
      return { hasToken: Boolean(token), principal };
    }).catch(() => null);
    if (last?.hasToken && last?.principal?.role === 'customer' && last?.principal?.actorId) return last;
    await sleep(250);
  }
  throw new Error(`Customer UI did not establish authenticated scoped session; last=${JSON.stringify(last)}`);
}

async function setPortalSession(page, portalUrl, tokenKey, principalKey, session) {
  await gotoStable(page, portalUrl);
  await page.evaluate(({ tokenKey, principalKey, session }) => {
    localStorage.setItem(tokenKey, session.accessToken);
    localStorage.setItem(principalKey, JSON.stringify(session.principal));
  }, { tokenKey, principalKey, session });
  await gotoStable(page, portalUrl);
}

async function waitForButton(pageOrLocator, name, timeout = 30_000) {
  const button = pageOrLocator.getByRole('button', { name, exact: typeof name === 'string' });
  await button.waitFor({ state: 'visible', timeout });
  return button;
}

async function renderSmoke(browser) {
  log('Running desktop/mobile browser render smoke across all six canonical portals.');
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
      log(`${viewport.name}: ${name} rendered at ${url}`);
    }
    await context.close();
  }
}

async function productionLifecycle(browser) {
  assert.ok(ADMIN_EMAIL && ADMIN_PASSWORD, 'ADMIN_EMAIL and ADMIN_PASSWORD are required for lifecycle mode');
  const marker = `browser-acceptance-${Date.now()}`;

  log('1/10 Customer: sign in through the real UI and create a tagged case.');
  const customerContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    geolocation: { latitude: 45.5152, longitude: -122.6784 },
    permissions: ['geolocation']
  });
  const customer = await customerContext.newPage();
  await gotoStable(customer, `${PORTALS.customer}/login`);
  await customer.locator('#email').fill(ADMIN_EMAIL);
  await customer.locator('#password').fill(ADMIN_PASSWORD);
  await customer.getByRole('button', { name: 'Sign in' }).click();
  await waitForCustomerSession(customer);
  await gotoStable(customer, `${PORTALS.customer}/cases/new`);
  await customer.locator('#issueType').selectOption('wont_start');
  await customer.locator('#description').fill(marker);
  await customer.locator('#urgency').selectOption('urgent');
  await customer.getByRole('button', { name: 'Capture GPS' }).click();
  await customer.getByText(/GPS ready for dispatch/i).waitFor({ state: 'visible', timeout: 20_000 });
  const demandResponsePromise = customer.waitForResponse(
    response => response.url().includes('/api/demands') && response.request().method() === 'POST',
    { timeout: 30_000 }
  );
  await customer.getByRole('button', { name: 'Submit' }).click();
  const demandResponse = await demandResponsePromise;
  const demandText = await demandResponse.text();
  assert.ok(demandResponse.ok(), `Customer demand submission failed: ${demandResponse.status()} ${demandText.slice(0, 1000)}`);
  let demandPayload;
  try { demandPayload = JSON.parse(demandText); } catch { demandPayload = null; }
  const caseId = demandPayload?.case?.id;
  assert.match(caseId ?? '', /^[0-9a-f-]{36}$/i, 'Customer demand response did not return a case id');
  await gotoStable(customer, `${PORTALS.customer}/cases/${caseId}`);
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

  log('3/10 Ops: move the case through triage, request diagnosis, and dispatch the test diagnostic provider.');
  const opsContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ops = await opsContext.newPage();
  await setPortalSession(ops, PORTALS.ops, 'roviq_access_token', 'roviq_principal', admin);
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);

  let liveCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  if (liveCase.case.state === 'intake') {
    const beginTriage = await waitForButton(ops, 'Begin triage');
    await beginTriage.click();
    await waitForCaseState(caseId, adminToken, 'triage');
    await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
    liveCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  }
  if (liveCase.case.state === 'triage') {
    const requestDiagnosis = await waitForButton(ops, 'Request diagnosis');
    await requestDiagnosis.click();
    await waitForCaseState(caseId, adminToken, 'diagnostic_pending');
    await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  }

  liveCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  assert.equal(liveCase.case.state, 'diagnostic_pending', `Ops preparation ended in unexpected state ${liveCase.case.state}`);
  assert.ok(liveCase.case.demand_id, 'Diagnostic-pending case is missing demand_id');

  const actors = await requestJson('/api/admin/actors?status=active', { token: adminToken });
  const activeDiagnosticIds = (actors.actors ?? []).filter(actor => actor.actor_type === 'diagnostic').map(actor => actor.id);
  assert.ok(activeDiagnosticIds.includes(diagnosticSession.principal.actorId), `Test diagnostic actor ${diagnosticSession.principal.actorId} is not active/dispatchable; active=${JSON.stringify(activeDiagnosticIds)}`);

  const diagnosticSection = ops.locator('section').filter({ hasText: 'Diagnostic handoff' }).first();
  const diagnosticSelect = diagnosticSection.locator('select');
  await diagnosticSelect.waitFor({ state: 'visible', timeout: 30_000 });
  await diagnosticSelect.selectOption(diagnosticSession.principal.actorId);
  await diagnosticSection.getByRole('button', { name: 'Send diagnostic offer' }).click();
  await diagnosticSection.getByText(/has been offered this case/i).waitFor({ timeout: 20_000 });
  await screenshot(ops, 'lifecycle-02-ops-diagnostic-dispatch');

  log('4/10 Diagnostic: accept the exact case and route the non-drivable vehicle to tow through the Diagnostic UI.');
  const diagnosticItem = await waitForCollectionItem(
    '/api/diagnostics/me/queue',
    diagnosticSession.accessToken,
    'queue',
    item => item.case_id === caseId
  );
  assert.ok(diagnosticItem.demand_id, 'Diagnostic queue item is missing demand_id');
  const diagnosticContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const diagnostic = await diagnosticContext.newPage();
  await setPortalSession(diagnostic, PORTALS.diagnostic, 'roviq_diagnostic_token', 'roviq_diagnostic_principal', diagnosticSession);
  const diagnosticCard = diagnostic.locator(`button.queue-card[data-case-id="${caseId}"]`).first();
  await diagnosticCard.waitFor({ state: 'visible', timeout: 30_000 });
  await diagnosticCard.click();
  if (diagnosticItem.outcome === 'offered') {
    const accept = await waitForButton(diagnostic, 'Accept assignment');
    await accept.click();
  }
  const findingForm = diagnostic.locator('form.finding-form');
  await findingForm.waitFor({ state: 'visible', timeout: 30_000 });
  await findingForm.locator('textarea').fill('Browser acceptance: verified non-drivable vehicle requiring tow to repair provider.');
  await findingForm.getByLabel('Vehicle condition').selectOption('non_drivable');
  await findingForm.getByLabel('Recommended next step').selectOption('route_to_tow');
  await findingForm.getByRole('button', { name: 'Save finding & hand off' }).click();
  await waitForCaseState(caseId, adminToken, 'tow_pending');
  await screenshot(diagnostic, 'lifecycle-03-diagnostic-to-tow');

  log('5/10 Ops + Tow: assign Tow / Valet, then drive every dispatch status to delivered through the Tow UI.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const towSection = ops.locator('section').filter({ hasText: 'Tow handoff' }).first();
  const towSelect = towSection.locator('select');
  await towSelect.waitFor({ state: 'visible', timeout: 30_000 });
  await towSelect.selectOption(towSession.principal.actorId);
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
    const button = await waitForButton(tow, label);
    await button.click();
    await waitForCollectionItem('/api/transport/me/dispatches', towSession.accessToken, 'dispatches', item => item.id === dispatch.id && item.status === expected);
  }
  await screenshot(tow, 'lifecycle-04-tow-delivered');

  log('6/10 Ops + Partner: route/select a repair provider and accept it in Partner.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const liveAfterTow = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  if (liveAfterTow.case.state !== 'provider_selection') {
    const next = ops.locator('section').filter({ hasText: 'Next action' }).getByRole('button').first();
    await next.waitFor({ state: 'visible', timeout: 30_000 });
    await next.click();
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
  await offerCard.waitFor({ state: 'visible', timeout: 30_000 });
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
    if (line.approval_status !== 'approved') {
      await requestJson(`/api/shop-os/repair-order-lines/${line.id}`, {
        method: 'PATCH', token: partnerSession.accessToken, body: { approvalStatus: 'approved' }
      });
    }
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
    const button = await waitForButton(parts, label);
    await button.click();
    await waitForCollectionItem('/api/parts/me/requests', partsSession.accessToken, 'requests', item => item.id === partsRequestId && item.status === expected);
  }
  await screenshot(parts, 'lifecycle-06-parts-received');

  log('8/10 Partner: finish the repair and confirm completion.');
  const currentOrder = await requestJson(`/api/shop-os/repair-orders/${orderId}`, { token: partnerSession.accessToken });
  if (currentOrder.order.status === 'approved') {
    await requestJson(`/api/shop-os/repair-orders/${orderId}/start`, { method: 'POST', token: partnerSession.accessToken, body: {} });
  }
  const startedOrder = await requestJson(`/api/shop-os/repair-orders/${orderId}`, { token: partnerSession.accessToken });
  assert.ok(['in_progress', 'completed'].includes(startedOrder.order.status), `Repair order did not start; status=${startedOrder.order.status}`);
  if (startedOrder.order.status === 'in_progress') {
    await requestJson(`/api/shop-os/repair-orders/${orderId}/complete`, { method: 'POST', token: partnerSession.accessToken, body: {} });
  }
  const completedOrder = await requestJson(`/api/shop-os/repair-orders/${orderId}`, { token: partnerSession.accessToken });
  assert.equal(completedOrder.order.status, 'completed', 'Repair order did not complete');
  await screenshot(partner, 'lifecycle-07-repair-complete');

  log('9/10 Payment: advance the case to payment when Core exposes that transition, then exercise the payment handoff.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  let prePaymentCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  if (prePaymentCase.case.state === 'repair_in_progress') {
    const transitions = await requestJson(`/api/maintenance/cases/${caseId}/transitions`, { token: adminToken });
    if ((transitions.transitions ?? []).some(t => t.toState === 'payment_pending')) {
      const paymentAction = await waitForButton(ops, 'Request payment');
      await paymentAction.click();
      await waitForCaseState(caseId, adminToken, 'payment_pending');
      await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
      prePaymentCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
    }
  }
  const paymentLink = ops.getByRole('link', { name: /payment/i }).first();
  if (await paymentLink.isVisible().catch(() => false)) {
    await paymentLink.click();
    await ops.waitForLoadState('domcontentloaded');
  }
  await screenshot(ops, 'lifecycle-08-payment-handoff');

  log('10/10 Core: verify authority and require the case to reach the payment/completion stage.');
  const finalCase = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
  assert.equal(finalCase.case.id, caseId);
  assert.ok(['payment_pending', 'completed'].includes(finalCase.case.state), `Lifecycle stopped too early in ${finalCase.case.state}`);

  await Promise.allSettled([
    customerContext.close(), opsContext.close(), diagnosticContext.close(), towContext.close(), partnerContext.close(), partsContext.close()
  ]);
  log(`Credentialed production lifecycle reached ${finalCase.case.state} for case ${caseId}.`);
}

const browser = await chromium.launch({ headless: true });
try {
  if (MODE === 'render') await renderSmoke(browser);
  else if (MODE === 'lifecycle') await productionLifecycle(browser);
  else throw new Error(`Unknown BROWSER_MODE=${MODE}`);
} finally {
  await browser.close();
}
