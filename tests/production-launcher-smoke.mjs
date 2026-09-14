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

async function launcherState(page, name) {
  return page.evaluate((portalName) => {
    const tile = document.querySelector(`.tile[data-name="${portalName}"]`);
    const frame = document.querySelector('#portalFrame');
    const stage = document.querySelector('#stageName');
    const fallback = document.querySelector('#fallback');
    return {
      tileOuterHTML: tile?.outerHTML ?? null,
      tileHref: tile?.getAttribute('href') ?? null,
      tileDataUrl: tile?.getAttribute('data-url') ?? null,
      tileDataHref: tile?.getAttribute('data-href') ?? null,
      frameAttrSrc: frame?.getAttribute('src') ?? null,
      frameResolvedSrc: frame?.src ?? null,
      stageText: stage?.textContent?.trim() ?? null,
      fallbackHref: fallback?.getAttribute('href') ?? null
    };
  }, name);
}

async function selectPortal(page, name, expectedHost, expectedStage) {
  const tile = page.locator(`.tile[data-name="${name}"]`);
  await tile.waitFor({ state: 'visible', timeout: 15_000 });
  const before = await launcherState(page, name);
  console.log(`[launcher] before ${name}: ${JSON.stringify(before)}`);
  await tile.click();
  try {
    await page.waitForFunction(
      host => {
        const frame = document.querySelector('#portalFrame');
        return frame?.getAttribute('src')?.includes(host) || frame?.src?.includes(host);
      },
      expectedHost,
      { timeout: 30_000 }
    );
  } catch (error) {
    const after = await launcherState(page, name);
    console.log(`[launcher] after ${name}: ${JSON.stringify(after)}`);
    fs.appendFileSync(path.join(ARTIFACT_DIR, 'launcher-state.jsonl'), `${JSON.stringify({ name, before, after })}\n`);
    throw error;
  }
  assert.match(await page.locator('#stageName').innerText(), expectedStage);
  assert.match(await page.locator('#fallback').getAttribute('href') ?? '', new RegExp(expectedHost.replaceAll('.', '\\.')));
  const frameBody = page.frameLocator('#portalFrame').locator('body');
  await frameBody.waitFor({ state: 'visible', timeout: 30_000 });
  const text = (await frameBody.innerText()).trim();
  assert.match(text, /ROVIQ/i, `${name} portal should render inside launcher`);
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

    await selectPortal(page, 'Customer', 'roviq-web-dxv.pages.dev', /Customer/i);
    await selectPortal(page, 'Diagnostic', 'roviq-diagnostic-net.pages.dev', /Diagnostic/i);

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
