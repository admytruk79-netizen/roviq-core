import { createHmac, timingSafeEqual } from 'node:crypto';
import { refundPayment, updatePaymentState } from './payments.js';
import type { Principal } from '../types/principal.js';

export type PaymentWebhookEvent={
  id:string;
  type:'payment.requires_action'|'payment.authorized'|'payment.captured'|'payment.cancelled'|'payment.failed'|'payment.refunded';
  paymentIntentId:string;
  amount?:number;
  payload?:Record<string,unknown>;
};

function secretName(provider:string){
  return `PAYMENT_WEBHOOK_SECRET_${provider.replace(/[^a-z0-9]/gi,'_').toUpperCase()}`;
}

export function canonicalWebhookPayload(timestamp:number,event:PaymentWebhookEvent){
  return `${timestamp}.${JSON.stringify(event)}`;
}

export function signWebhook(secret:string,timestamp:number,event:PaymentWebhookEvent){
  return createHmac('sha256',secret).update(canonicalWebhookPayload(timestamp,event)).digest('hex');
}

export function verifyPaymentWebhook(provider:string,timestamp:number,event:PaymentWebhookEvent,signature:string,now=Date.now()){
  const secret=process.env[secretName(provider)];
  if(!secret) throw new Error('payment_webhook_not_configured');
  if(!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp*1000)>5*60*1000) throw new Error('payment_webhook_timestamp_invalid');
  if(!/^[a-f0-9]{64}$/i.test(signature)) throw new Error('payment_webhook_signature_invalid');
  const expected=Buffer.from(signWebhook(secret,timestamp,event),'hex');
  const actual=Buffer.from(signature,'hex');
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual)) throw new Error('payment_webhook_signature_invalid');
}

export async function applyPaymentWebhook(provider:string,event:PaymentWebhookEvent){
  const principal:Principal={role:'admin'};
  const payload={provider,...(event.payload??{})};
  switch(event.type){
    case 'payment.requires_action': return updatePaymentState(principal,event.paymentIntentId,'requires_action',{amount:event.amount,providerEventId:event.id,payload});
    case 'payment.authorized': return updatePaymentState(principal,event.paymentIntentId,'authorized',{amount:event.amount,providerEventId:event.id,payload});
    case 'payment.captured': return updatePaymentState(principal,event.paymentIntentId,'captured',{amount:event.amount,providerEventId:event.id,payload});
    case 'payment.cancelled': return updatePaymentState(principal,event.paymentIntentId,'cancelled',{amount:event.amount,providerEventId:event.id,payload});
    case 'payment.failed': return updatePaymentState(principal,event.paymentIntentId,'failed',{amount:event.amount,providerEventId:event.id,payload});
    case 'payment.refunded':
      if(event.amount===undefined) throw new Error('payment_webhook_amount_required');
      return refundPayment(principal,event.paymentIntentId,event.amount,event.id,payload);
  }
}
