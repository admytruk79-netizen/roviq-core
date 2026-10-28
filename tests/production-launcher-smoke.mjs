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

    // Exercise owner setup against a simulated response, never create public production accounts.
    await page.getByRole('button',{name:'Create your shop',exact:true}).click();
    await page.getByRole('heading',{name:'Create your shop',exact:true}).waitFor();
    await page.screenshot({path:path.join(output,`${viewport.name}-shop-registration.png`),fullPage:true});
    const submissions=[];
    await page.route('**/api/shops/register',async route=>{
      const headers={'access-control-allow-origin':new URL(APPS.actor).origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'};
      if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
      assert.equal(route.request().method(),'POST');
      const payload=route.request().postDataJSON();
      assert.deepEqual(Object.keys(payload).sort(),['businessName','email','location','operatorName','password','requestId'].sort());
      assert.match(payload.requestId,/^[0-9a-f-]{36}$/i);
      assert.deepEqual(Object.keys(payload.location).sort(),['address','city','countryCode','name','region'].sort());
      submissions.push(payload);
      await route.fulfill({status:submissions.length===1?503:201,contentType:'application/json',headers,body:JSON.stringify(submissions.length===1?{error:'temporary_failure'}:{business:{readiness:'configuration_required',role:'partner'}})});
    });
    const fields={'Shop name':'Browser test shop','Your name':'Browser owner','Sign-in email':'browser-owner@example.test','Password (12–128 characters)':'Browser-only-password-123!','Location name':'Main workshop','Street address':'123 Test Street','City':'Portland','State / province / region':'OR','Two-letter country code (for example US or CA)':'12'};
    for(const [label,value] of Object.entries(fields)) await page.getByLabel(label,{exact:true}).fill(value);
    const country=page.getByLabel('Two-letter country code (for example US or CA)',{exact:true});
    assert.equal(await country.evaluate(input=>input.checkValidity()),false);
    assert.equal(submissions.length,0);
    await country.fill('US');
    await page.getByRole('button',{name:'Create shop workspace',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Shop setup could not be completed'}).waitFor();
    await page.getByRole('button',{name:'Create shop workspace',exact:true}).click();
    await page.getByRole('heading',{name:'Sign in to ROVIQ Actor'}).waitFor();
    assert.equal(submissions.length,2);
    assert.deepEqual(submissions[0],submissions[1],'unchanged setup retries must retain their idempotency key');
    assert.equal(await page.getByLabel('Email',{exact:true}).inputValue(),'browser-owner@example.test');
    assert.equal(await page.getByLabel(/^Password/).inputValue(),'');
    assert.equal(await page.evaluate(()=>localStorage.getItem('roviq_actor_session')),null,'registration must not manufacture a signed-in session');
    await page.getByRole('status').filter({hasText:'Your shop workspace is ready'}).waitFor();
    await page.unroute('**/api/shops/register');
    await page.goto(new URL('/login',APPS.customer).toString(),{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'Welcome back'}).waitFor({timeout:20000});
    await page.screenshot({path:path.join(output,`${viewport.name}-customer-signin.png`),fullPage:true});
    await context.close();
  }
  console.log('[roviq-browser] Customer and Actor manifests, product entry points, sign-in and simulated shop setup/retry pass on desktop and mobile.');
}finally{await browser.close();}
