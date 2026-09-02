import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const EDGE_URL = process.env.EDGE_URL ?? 'https://roviq-core.admytruk79.workers.dev';
const MODE = process.env.BROWSER_MODE ?? 'render';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ARTIFACT_DIR = path.resolve(process.env.BROWSER_ARTIFACT_DIR ?? 'artifacts/production-browser');

const PORTALS = {
  customer: 'https://roviq-web-dxv.pages.dev',
  diagnostic: 'https://roviq-diagnostic-net.pages.dev',
  partner: 'https://roviq-partner.pages.dev',
  parts: 'https://roviq-parts-net.pages.dev',
  tow: 'https://roviq-tow-net.pages.dev',
  ops: 'https://roviq-ops.pages.dev'
};

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function log(message) {
  console.log(`[roviq-browser] ${message}`);
}

async function gotoStable(page, url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
      const text = (await page.locator('body').innerText()).trim();
      if (text.length >= 10) return;
      throw new Error('empty_document');
    } catch (error) {
      lastError = error;
      if (attempt < 5) await page.waitForTimeout(attempt * 1_000);
    }
  }
  throw lastError ?? new Error(`Unable to load ${url}`);
}

async function screenshot(page, name) {
  const safe = name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  await page.screenshot({ path: path.join(ARTIFACT_DIR, `${safe}.png`), fullPage: true }).catch(() => {});
}

async function requestJson(apiPath, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${EDGE_URL}${apiPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    throw new Error(`${method} ${apiPath} -> ${response.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForCaseState(caseId, adminToken, expected, timeoutMs = 30_000) {
  const start = Date.now();
  let last = null;
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await requestJson(`/api/maintenance/cases/${caseId}`, { token: adminToken });
      last = result?.case?.state ?? null;
      lastError = null;
      if (last === expected) return result.case;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  const errorDetail = lastError instanceof Error ? `; last read error=${lastError.message}` : '';
  throw new Error(`Case ${caseId} did not reach ${expected}; last state=${last}${errorDetail}`);
}

async function waitForCollectionItem(apiPath, token, collectionKey, predicate, description, timeoutMs = 30_000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await requestJson(apiPath, { token });
      const collection = Array.isArray(result?.[collectionKey]) ? result[collectionKey] : [];
      const item = collection.find(predicate);
      if (item) return item;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  const errorDetail = lastError instanceof Error ? `; last read error=${lastError.message}` : '';
  throw new Error(`${description}${errorDetail}`);
}

async function setPortalSession(page, portalUrl, tokenKey, principalKey, session) {
  await gotoStable(page, `${portalUrl}/`);
  await page.evaluate(({ tokenKey, principalKey, session }) => {
    localStorage.clear();
    localStorage.setItem(tokenKey, session.accessToken);
    localStorage.setItem(principalKey, JSON.stringify(session.principal));
  }, { tokenKey, principalKey, session });
  await gotoStable(page, `${portalUrl}/`);
}

async function surfaceRenderSmoke(browser) {
  log('Running desktop/mobile browser render smoke across all six portals.');
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 }
  ];

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    try {
      for (const [name, url] of Object.entries(PORTALS)) {
        const page = await context.newPage();
        await gotoStable(page, url);
        const body = (await page.locator('body').innerText()).trim();
        assert.match(body, /ROVIQ/i, `${name} should render ROVIQ branding`);
        assert.ok(body.length > 30, `${name} rendered body is unexpectedly short`);
        await screenshot(page, `${viewport.name}-${name}`);
        await page.close();
        log(`${viewport.name}: ${name} rendered`);
      }
    } finally {
      await context.close();
    }
  }
}

async function productionLifecycle(browser) {
  assert.ok(ADMIN_EMAIL && ADMIN_PASSWORD, 'Credentialed lifecycle requires ADMIN_EMAIL and ADMIN_PASSWORD');
  const marker = `ROVIQ browser acceptance ${new Date().toISOString()}`;
  const sku = `ROVIQ-BROWSER-${Date.now()}`;

  log('1/10 Customer: sign in through the real UI and create a tagged case.');
  const customerContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
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
  const diagnosticSection = ops.locator('section').filter({ hasText: 'Diagnostic handoff' }).first();
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
  await towSection.locator('select').selectOption(towSession.principal.actorId);
  await towSection.getByRole('button', { name: /Create and assign tow|Assign Tow provider/i }).click();

  const dispatch = await waitForCollectionItem(
    '/api/transport/me/dispatches',
    towSession.accessToken,
    'dispatches',
    item => item.case_id === caseId,
    `Tow queue does not contain case ${caseId}`
  );
  const towContext = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const tow = await towContext.newPage();
  await setPortalSession(tow, PORTALS.tow, 'roviq_tow_token', 'roviq_tow_principal', towSession);
  // The Drive tab auto-selects the sole active dispatch and shows its actions directly -- a later
  // tow UI redesign ("declutter live map and collapse trip details") replaced the separate
  // dispatch-card selection step this test used to rely on, so there is no card to click here.
  await tow.getByText(`Case ${casePrefix}`).waitFor({ timeout: 20_000 });
  const acceptTow = tow.getByRole('button', { name: 'Accept', exact: true });
  if (await acceptTow.isVisible().catch(() => false)) await acceptTow.click();
  for (const label of ['en route', 'arrived', 'vehicle loaded', 'in transit', 'delivered']) {
    const button = tow.getByRole('button', { name: new RegExp(`Mark ${label}`, 'i') });
    await button.waitFor({ state: 'visible', timeout: 20_000 });
    await button.click();
  }
  await waitForCaseState(caseId, adminToken, 'tow_in_progress');
  await screenshot(tow, 'lifecycle-04-tow-delivered');

  log('6/10 Partner: offer the exact test partner, accept through Partner UI, send quote and request a part.');
  await requestJson('/api/admin/offers', {
    method: 'POST', token: adminToken,
    body: { demandId, actorId: partnerSession.principal.actorId, rank: 1, ruleBasis: 'production_browser_acceptance' }
  });
  const partnerContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const partner = await partnerContext.newPage();
  await setPortalSession(partner, PORTALS.partner, 'roviq_partner_token', 'roviq_partner_principal', partnerSession);
  const respondResponses = [];
  partner.on('response', async response => {
    if (!response.url().includes('/api/offers/') && !response.url().includes('/api/partners/me/offers')) return;
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    respondResponses.push({ url: new URL(response.url()).pathname, status: response.status(), body });
  });
  const offerCard = partner.locator('article.offer').filter({ hasText: `Case ${casePrefix}` }).first();
  await offerCard.getByRole('button', { name: 'Accept work' }).click();
  await partner.waitForTimeout(3000);
  console.log(`[roviq-browser] debug respond responses: ${JSON.stringify(respondResponses)}`);
  await waitForCaseState(caseId, adminToken, 'repair_in_progress');
  await partner.getByText(/Work accepted/i).waitFor({ timeout: 20_000 }).catch(() => {});
  const workbench = partner.getByRole('heading', { name: 'Repair workbench' });
  if (!await workbench.isVisible().catch(() => false)) {
    const acceptedCase = partner.getByRole('button').filter({ hasText: `Case ${casePrefix}` }).first();
    if (await acceptedCase.isVisible().catch(() => false)) await acceptedCase.click();
  }
  await workbench.waitFor({ timeout: 20_000 });
  const quoteForm = partner.locator('form').filter({ hasText: 'Customer quote' }).first();
  await quoteForm.getByPlaceholder('Reason for quote').fill('Browser acceptance verified repair');
  await quoteForm.getByPlaceholder('Customer-facing summary (optional)').fill('Verified repair after diagnosis and tow.');
  await quoteForm.getByPlaceholder('Repair task').fill('Complete verified browser-acceptance repair');
  await quoteForm.getByPlaceholder('Amount USD').fill('159.00');
  await quoteForm.getByRole('button', { name: 'Send quote for approval' }).click();
  await partner.getByText(/Quote sent to the customer for approval/i).waitFor({ timeout: 20_000 });
  const partsForm = partner.locator('form').filter({ hasText: 'Parts handoff' }).first();
  await partsForm.getByPlaceholder('SKU / internal part code').fill(sku);
  await partsForm.getByPlaceholder('Part description').fill('Browser acceptance component');
  await partsForm.getByPlaceholder('Quantity').fill('1');
  await partsForm.getByRole('button', { name: 'Request parts' }).click();
  await partner.getByText(/Parts request .* created/i).waitFor({ timeout: 20_000 });
  await waitForCaseState(caseId, adminToken, 'parts_pending');
  await screenshot(partner, 'lifecycle-05-partner-quote-parts');

  log('7/10 Ops + Parts: assign the Parts test actor, stock the requested SKU, reserve and deliver through Parts UI.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const partsSection = ops.locator('section').filter({ hasText: 'Parts supplier handoff' }).first();
  await partsSection.locator('select').selectOption(partsSession.principal.actorId);
  await partsSection.getByRole('button', { name: /Assign supplier|Reassign supplier/i }).click();

  const order = await waitForCollectionItem(
    '/api/parts/me/orders',
    partsSession.accessToken,
    'orders',
    item => item.case_id === caseId,
    `Parts portal does not contain case ${caseId}`
  );
  const partsContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const parts = await partsContext.newPage();
  await setPortalSession(parts, PORTALS.parts, 'roviq_parts_token', 'roviq_parts_principal', partsSession);
  const orderCard = parts.locator('article.order-card').filter({ hasText: `Case ${casePrefix}` }).first();
  await orderCard.locator('button.order-select').click();
  const inventoryForm = parts.locator('form.inventory-form');
  await inventoryForm.getByLabel('Stock on hand').fill('2');
  await inventoryForm.getByLabel('Unit price (USD)').fill('40');
  await inventoryForm.getByRole('button', { name: 'Save inventory' }).click();
  await parts.getByText(new RegExp(`Inventory saved for ${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')).waitFor({ timeout: 20_000 });
  for (const action of ['Reserve stock', 'Mark ordered', 'Mark shipped', 'Mark delivered']) {
    const button = orderCard.getByRole('button', { name: action });
    await button.waitFor({ state: 'visible', timeout: 20_000 });
    await button.click();
  }
  await waitForCaseState(caseId, adminToken, 'repair_in_progress');
  await screenshot(parts, 'lifecycle-06-parts-delivered');

  log('8/10 Partner + Customer: request approval/payment, then approve the current quote through Customer UI.');
  await partner.getByRole('button', { name: 'Refresh case' }).click();
  const paymentRequest = partner.getByRole('button', { name: 'Request approval & payment' });
  await paymentRequest.waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await paymentRequest.isEnabled(), true, 'Partner payment request should be enabled after parts delivery');
  await paymentRequest.click();
  await waitForCaseState(caseId, adminToken, 'payment_pending');
  await gotoStable(customer, `${PORTALS.customer}/cases/${caseId}`);
  const customerRefresh = customer.getByRole('button', { name: 'Refresh' }).first();
  if (await customerRefresh.isVisible().catch(() => false)) await customerRefresh.click();
  const approvalPanel = customer.locator('div').filter({ hasText: 'Approval needed:' }).first();
  await approvalPanel.getByRole('button', { name: 'Approve' }).click();
  const servicePlan = await requestJson(`/api/maintenance/cases/${caseId}/service-plan`, { token: customerToken });
  assert.ok(servicePlan.approvals.some(item => item.approval_type === 'quote' && item.state === 'approved'), 'Customer quote approval was not persisted');
  await screenshot(customer, 'lifecycle-07-customer-approved');

  log('9/10 Ops: create payment and capture it through the production payment handoff UI.');
  await gotoStable(ops, `${PORTALS.ops}/cases/${caseId}`);
  const paymentSection = ops.locator('section').filter({ hasText: 'Customer payment handoff' }).first();
  const paymentRefresh = paymentSection.getByRole('button', { name: 'Refresh' });
  if (await paymentRefresh.isVisible().catch(() => false)) await paymentRefresh.click();
  const createPayment = paymentSection.getByRole('button', { name: 'Create payment' });
  await createPayment.waitFor({ state: 'visible', timeout: 20_000 });
  await createPayment.click();
  await paymentSection.getByText(/Payment intent created/i).waitFor({ timeout: 20_000 });
  const capture = paymentSection.getByRole('button', { name: 'Capture & complete case' });
  await capture.click();
  await waitForCaseState(caseId, adminToken, 'completed');
  await screenshot(ops, 'lifecycle-08-ops-completed');

  log('10/10 Customer: refresh the same case and verify the deployed Customer UI shows completion.');
  await gotoStable(customer, `${PORTALS.customer}/cases/${caseId}`);
  const finalRefresh = customer.getByRole('button', { name: 'Refresh' }).first();
  if (await finalRefresh.isVisible().catch(() => false)) await finalRefresh.click();
  await customer.getByText(/^completed$/i).first().waitFor({ state: 'visible', timeout: 20_000 });
  await screenshot(customer, 'lifecycle-09-customer-completed');

  const result = { caseId, demandId, marker, sku, completedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'lifecycle-result.json'), JSON.stringify(result, null, 2));
  log(`Production browser lifecycle completed successfully for case ${caseId}.`);

  await Promise.allSettled([
    customerContext.close(), opsContext.close(), diagnosticContext.close(), towContext.close(), partnerContext.close(), partsContext.close()
  ]);
}

const browser = await chromium.launch({ headless: true });
try {
  if (MODE === 'render') {
    await surfaceRenderSmoke(browser);
  } else if (MODE === 'lifecycle') {
    await productionLifecycle(browser);
  } else {
    throw new Error(`Unknown BROWSER_MODE=${MODE}`);
  }
} catch (error) {
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'failure.txt'), `${error?.stack ?? error}\n`);
  throw error;
} finally {
  await browser.close();
}