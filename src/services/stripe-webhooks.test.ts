import { createHmac } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { verifyStripeSignature } from './stripe-webhooks.js';

function signature(secret:string,timestamp:number,body:Buffer){
  const digest=createHmac('sha256',secret).update(`${timestamp}.`).update(body).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Stripe webhook signature verification',()=>{
  it('accepts a valid current signature',()=>{
    const secret='whsec_test_secret';
    const timestamp=1_800_000_000;
    const body=Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}');
    expect(()=>verifyStripeSignature(body,signature(secret,timestamp,body),secret,timestamp)).not.toThrow();
  });

  it('rejects a modified payload',()=>{
    const secret='whsec_test_secret';
    const timestamp=1_800_000_000;
    const signed=Buffer.from('{"id":"evt_1"}');
    const changed=Buffer.from('{"id":"evt_2"}');
    expect(()=>verifyStripeSignature(changed,signature(secret,timestamp,signed),secret,timestamp))
      .toThrow('stripe_signature_invalid');
  });

  it('rejects a signature outside the replay window',()=>{
    const secret='whsec_test_secret';
    const timestamp=1_800_000_000;
    const body=Buffer.from('{"id":"evt_1"}');
    expect(()=>verifyStripeSignature(body,signature(secret,timestamp,body),secret,timestamp+301))
      .toThrow('stripe_signature_expired');
  });
});
