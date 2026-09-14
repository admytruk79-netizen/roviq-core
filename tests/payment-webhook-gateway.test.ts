import { afterEach, describe, expect, it } from 'vitest';
import { signWebhook, verifyPaymentWebhook, type PaymentWebhookEvent } from '../src/services/payment-webhook-gateway.js';

const provider='testpay';
const envKey='PAYMENT_WEBHOOK_SECRET_TESTPAY';
const event:PaymentWebhookEvent={
  id:'evt-1',
  type:'payment.captured',
  paymentIntentId:'00000000-0000-4000-8000-000000000001',
  amount:125
};

afterEach(()=>{delete process.env[envKey];});

describe('payment webhook verification',()=>{
  it('accepts a correctly signed fresh event',()=>{
    process.env[envKey]='test-secret';
    const now=1_800_000_000_000;
    const timestamp=Math.floor(now/1000);
    const signature=signWebhook(process.env[envKey]!,timestamp,event);
    expect(()=>verifyPaymentWebhook(provider,timestamp,event,signature,now)).not.toThrow();
  });

  it('fails closed when provider secret is missing',()=>{
    expect(()=>verifyPaymentWebhook(provider,1,event,'0'.repeat(64),1000)).toThrow('payment_webhook_not_configured');
  });

  it('rejects stale replay attempts',()=>{
    process.env[envKey]='test-secret';
    const now=1_800_000_000_000;
    const timestamp=Math.floor((now-6*60*1000)/1000);
    const signature=signWebhook(process.env[envKey]!,timestamp,event);
    expect(()=>verifyPaymentWebhook(provider,timestamp,event,signature,now)).toThrow('payment_webhook_timestamp_invalid');
  });

  it('rejects a signature for a mutated event',()=>{
    process.env[envKey]='test-secret';
    const now=1_800_000_000_000;
    const timestamp=Math.floor(now/1000);
    const signature=signWebhook(process.env[envKey]!,timestamp,event);
    const changed={...event,amount:126};
    expect(()=>verifyPaymentWebhook(provider,timestamp,changed,signature,now)).toThrow('payment_webhook_signature_invalid');
  });
});
