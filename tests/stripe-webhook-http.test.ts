import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { stripeMinorToMajor } from '../src/services/stripe-webhook.js';

const previousSecret=process.env.STRIPE_WEBHOOK_SECRET;

afterEach(()=>{
  if(previousSecret===undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET=previousSecret;
});

function signature(secret:string,timestamp:number,body:string){
  const digest=createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Stripe-native webhook boundary',()=>{
  it('accepts a genuine Stripe-style signature over the exact raw body',async()=>{
    process.env.STRIPE_WEBHOOK_SECRET='whsec_test_only';
    const app=await buildApp();
    const timestamp=Math.floor(Date.now()/1000);
    const body='{"id":"evt_http_raw","type":"customer.created","data":{"object":{"id":"cus_123"}}}';
    const response=await app.inject({
      method:'POST',
      url:'/api/payments/webhooks/stripe',
      headers:{'content-type':'application/json','stripe-signature':signature(process.env.STRIPE_WEBHOOK_SECRET,timestamp,body)},
      payload:body
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({received:true,payment:null});
    await app.close();
  });

  it('acknowledges unsupported payment-intent event types without local lookup',async()=>{
    process.env.STRIPE_WEBHOOK_SECRET='whsec_test_only';
    const app=await buildApp();
    const timestamp=Math.floor(Date.now()/1000);
    const body='{"id":"evt_created","type":"payment_intent.created","data":{"object":{"id":"pi_external","currency":"usd","amount":1000}}}';
    const response=await app.inject({
      method:'POST',
      url:'/api/payments/webhooks/stripe',
      headers:{'content-type':'application/json','stripe-signature':signature(process.env.STRIPE_WEBHOOK_SECRET,timestamp,body)},
      payload:body
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({received:true,payment:null});
    await app.close();
  });

  it('rejects a signature if the raw body is modified',async()=>{
    process.env.STRIPE_WEBHOOK_SECRET='whsec_test_only';
    const app=await buildApp();
    const timestamp=Math.floor(Date.now()/1000);
    const signed='{"id":"evt_signed","type":"customer.created","data":{"object":{"id":"cus_1"}}}';
    const delivered='{"id":"evt_signed","type":"customer.created","data":{"object":{"id":"cus_2"}}}';
    const response=await app.inject({
      method:'POST',
      url:'/api/payments/webhooks/stripe',
      headers:{'content-type':'application/json','stripe-signature':signature(process.env.STRIPE_WEBHOOK_SECRET,timestamp,signed)},
      payload:delivered
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('stripe_webhook_signature_invalid');
    await app.close();
  });

  it('converts only currencies representable by current storage precision',()=>{
    expect(stripeMinorToMajor('USD',12345)).toBe(123.45);
    expect(stripeMinorToMajor('JPY',10000)).toBe(10000);
    expect(()=>stripeMinorToMajor('KWD',12345)).toThrow('stripe_currency_precision_unsupported');
    expect(()=>stripeMinorToMajor('ZZZ',100)).toThrow('stripe_currency_unsupported');
  });
});
