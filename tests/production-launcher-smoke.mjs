import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const LAUNCHER = 'https://roviq-portals.pages.dev';
const ARTIFACT_DIR = path.resolve(process.env.BROWSER_ARTIFACT_DIR ?? 'artifacts/production-browser');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

async function stable(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 });
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
    await page.frameLocator('#portalFrame').locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    const customerBody = (await page.frameLocator('#portalFrame').locator('body').innerText()).trim();
    assert.match(customerBody, /ROVIQ/i, 'Customer portal should render inside launcher');

    const diagnosticTile = page.locator('.tile[data-name="Diagnostic"]');
    await diagnosticTile.click();
    await page.waitForFunction(() => document.querySelector('#portalFrame')?.getAttribute('src')?.includes('roviq-diagnostic-net.pages.dev'));
    assert.match(await page.locator('#stageName').innerText(), /Diagnostic/i);
    assert.match(await page.locator('#fallback').getAttribute('href') ?? '', /roviq-diagnostic-net\.pages\.dev/);
    await page.frameLocator('#portalFrame').locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    const diagnosticBody = (await page.frameLocator('#portalFrame').locator('body').innerText()).trim();
    assert.match(diagnosticBody, /ROVIQ/i, 'Diagnostic portal should render inside launcher');

    await page.screenshot({ path: path.join(ARTIFACT_DIR, `${viewport.name}-launcher.png`), fullPage: true });
    await context.close();
  }
  console.log('[roviq-browser] Production launcher embeds Customer and Diagnostic portals on desktop/mobile.');
} catch (error) {
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'launcher-failure.txt'), `${error?.stack ?? error}\n`);
  throw error;
} finally {
  await browser.close();
}
