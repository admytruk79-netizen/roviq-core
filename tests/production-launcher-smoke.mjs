import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { LAUNCHER_URL } from './production-config.mjs';

const LAUNCHER = LAUNCHER_URL;
const ARTIFACT_DIR = path.resolve(process.env.BROWSER_ARTIFACT_DIR ?? 'artifacts/production-browser');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function stable(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
}

async function waitForEmbeddedBranding(frameBody, name, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await frameBody.innerText().catch(() => '')).trim();
    if (/ROVIQ/i.test(text)) return;
    await sleep(500);
  }
  throw new Error(`${name} portal iframe did not render ROVIQ branding; last body=${JSON.stringify(text.slice(0, 500))}`);
}

async function selectPortal(page, name, expectedStage) {
  const tile = page.locator(`.tile[data-name="${name}"]`);
  await tile.waitFor({ state: 'visible', timeout: 15_000 });

  const destination = await tile.getAttribute('data-url');
  assert.ok(destination, `${name} tile must expose a data-url destination`);
  const expectedUrl = new URL(destination);
  assert.equal(expectedUrl.protocol, 'https:', `${name} destination must use HTTPS`);
  assert.match(expectedUrl.hostname, /\.pages\.dev$/, `${name} destination must target a Pages portal`);

  await tile.click();
  await page.waitForFunction(
    target => {
      const frame = document.querySelector('#portalFrame');
      if (!frame) return false;
      const attr = frame.getAttribute('src');
      const resolved = frame.src;
      return attr === target || resolved === target || resolved === `${target}/`;
    },
    destination,
    { timeout: 30_000 }
  );

  assert.match(await page.locator('#stageName').innerText(), expectedStage);
  const fallbackHref = await page.locator('#fallback').getAttribute('href');
  assert.equal(fallbackHref, destination, `${name} fallback link must match tile destination`);

  const frameBody = page.frameLocator('#portalFrame').locator('body');
  await frameBody.waitFor({ state: 'visible', timeout: 30_000 });
  await waitForEmbeddedBranding(frameBody, name);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 }
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await stable(page, LAUNCHER);

    const body = (await page.locator('body').innerText()).trim();
    assert.match(body, /ROVIQ/i, 'launcher should render ROVIQ branding');
    assert.match(body, /Get help with your vehicle/i, 'launcher should expose Customer entry');

    const frame = page.locator('#portalFrame');
    await frame.waitFor({ state: 'visible', timeout: 15_000 });

    await selectPortal(page, 'Customer', /Customer/i);
    await selectPortal(page, 'Diagnostic', /Diagnostic/i);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, `${viewport.name}-launcher.png`), fullPage: true });
    await context.close();
  }
  console.log('[roviq-browser] Production launcher switches to and embeds its declared Customer and Diagnostic portals on desktop/mobile.');
} catch (error) {
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'launcher-failure.txt'), `${error?.stack ?? error}\n`);
  throw error;
} finally {
  await browser.close();
}
