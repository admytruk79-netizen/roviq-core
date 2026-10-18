import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {APPS} from './production-config.mjs';
const output=path.resolve(process.env.BROWSER_ARTIFACT_DIR??'artifacts/production-browser');
fs.mkdirSync(output,{recursive:true});
for(const [product,url] of Object.entries(APPS)){
  const response=await fetch(new URL('/manifest.json',url));
  assert.equal(response.status,200,`${product} manifest is unavailable`);
  const manifest=await response.json();
  assert.equal(manifest.name,product==='customer'?'ROVIQ Customer':'ROVIQ Actor');
  assert.equal(manifest.start_url,'/');
}
const browser=await chromium.launch({headless:true});
try{
  for(const viewport of [{name:'desktop',width:1440,height:900},{name:'mobile',width:390,height:844}]){
    const context=await browser.newContext({viewport});
    const page=await context.newPage();
    await page.goto(APPS.actor,{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'Your work, connected.'}).waitFor({timeout:20000});
    const customerLink=page.getByRole('link',{name:'Open ROVIQ Customer'});
    assert.equal(await customerLink.getAttribute('href'),APPS.customer);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('heading',{name:'Sign in to ROVIQ Actor'}).waitFor();
    await page.screenshot({path:path.join(output,`${viewport.name}-actor-signin.png`),fullPage:true});
    await page.goto(new URL('/login',APPS.customer).toString(),{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'Welcome back'}).waitFor({timeout:20000});
    await page.screenshot({path:path.join(output,`${viewport.name}-customer-signin.png`),fullPage:true});
    await context.close();
  }
  console.log('[roviq-browser] Customer and Actor manifests, product entry points and sign-in render on desktop and mobile.');
}finally{await browser.close();}
