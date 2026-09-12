import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import { refundPayment, updatePaymentState } from './payments.js';
import type { Principal } from '../types/principal.js';

type StripeObject={id?:string;amount?:number;amount_received?:number;amount_refunded?:number;payment_intent?:string|null;metadata?:Record<string,string>};
type StripeEvent={id:string;type:string;data:{object:StripeObject}};

function parseStripeSignature(header:string){
  const values=header.split(',').map(part=>part.trim().split('=',2));
  const timestamp=Number(values.find(([key])=>key==='t')?.[1]);
  const signatures=values.filter(([key])=>key==='v1').map(([,value])=>value).filter(Boolean);
  return {timestamp,signatures};
}

export function verifyStripeWebhook(rawBody:string,signatureHeader:string,now=Date.now()){
  const secret=process.env.STRIPE_WEBHOOK_SECRET;
  if(!secret) throw new Error('stripe_webhook_not_configured');
  const {timestamp,signatures}=parseStripeSignature(signatureHeader);
  if(!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp*1000)>5*60*1000) throw new Error('stripe_webhook_timestamp_invalid');
  const expected=createHmac('sha256',secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBuffer=Buffer.from(expected,'hex');
  const valid=signatures.some(signature=>{
    if(!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const actual=Buffer.from(signature,'hex');
    return actual.length===expectedBuffer.length&&timingSafeEqual(expectedBuffer,actual);
  });
  if(!valid) throw new Error('stripe_webhook_signature_invalid');
  let event:StripeEvent;
  try{event=JSON.parse(rawBody) as StripeEvent;}catch{throw new Error('stripe_webhook_payload_invalid');}
  if(!event?.id||!event?.type||!event?.data?.object) throw new Error('stripe_webhook_payload_invalid');
  return event;
}

async function localPaymentId(stripePaymentIntentId:string){
  const result=await pool.query(`select id from payment_intents where provider='stripe' and provider_intent_id=$1`,[stripePaymentIntentId]);
  if(!result.rowCount) throw new Error('payment_not_found');
  return String(result.rows[0].id);
}

function money(value:number|undefined){return value===undefined?undefined:value/100;}

export async function applyStripeWebhook(event:StripeEvent){
  const principal:Principal={role:'admin'};
  const object=event.data.object;
  if(event.type.startsWith('payment_intent.')){
    if(!object.id) throw new Error('stripe_webhook_payload_invalid');
    const paymentIntentId=await localPaymentId(object.id);
    const payload={provider:'stripe',stripeEventType:event.type,stripeObjectId:object.id};
    switch(event.type){
      case 'payment_intent.requires_action': return updatePaymentState(principal,paymentIntentId,'requires_action',{amount:money(object.amount),providerEventId:event.id,payload});
      case 'payment_intent.amount_capturable_updated': return updatePaymentState(principal,paymentIntentId,'authorized',{amount:money(object.amount),providerEventId:event.id,payload});
      case 'payment_intent.succeeded': return updatePaymentState(principal,paymentIntentId,'captured',{amount:money(object.amount_received??object.amount),providerEventId:event.id,payload});
      case 'payment_intent.canceled': return updatePaymentState(principal,paymentIntentId,'cancelled',{amount:money(object.amount),providerEventId:event.id,payload});
      case 'payment_intent.payment_failed': return updatePaymentState(principal,paymentIntentId,'failed',{amount:money(object.amount),providerEventId:event.id,payload});
      default:return null;
    }
  }
  if(event.type==='refund.created'){
    const stripeIntent=object.payment_intent;
    if(typeof stripeIntent!=='string'||!object.amount) throw new Error('stripe_webhook_payload_invalid');
    const paymentIntentId=await localPaymentId(stripeIntent);
    return refundPayment(principal,paymentIntentId,money(object.amount)!,event.id,{provider:'stripe',stripeEventType:event.type,stripeObjectId:object.id});
  }
  return null;
}
