import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import { refundPayment, updatePaymentState } from './payments.js';
import type { Principal } from '../types/principal.js';

type StripeObject={
  id?:string;
  amount?:number;
  amount_received?:number;
  amount_refunded?:number;
  payment_intent?:string|null;
  currency?:string;
  metadata?:Record<string,string>;
};
type StripeEvent={id:string;type:string;data:{object:StripeObject}};

const ZERO_DECIMAL_CURRENCIES=new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'
]);
const THREE_DECIMAL_CURRENCIES=new Set(['BHD','JOD','KWD','OMR','TND']);
const TWO_DECIMAL_CURRENCIES=new Set([
  'AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BGN','BMD','BND','BOB','BRL','BSD','BWP','BYN','BZD','CAD','CDF','CHF','CNY','COP','CRC','CVE','CZK','DKK','DOP','DZD','EGP','ETB','EUR','FJD','FKP','GBP','GEL','GIP','GMD','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','ISK','JMD','KES','KGS','KHR','KYD','KZT','LAK','LBP','LKR','LRD','LSL','MAD','MDL','MKD','MMK','MNT','MOP','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','PAB','PEN','PGK','PHP','PKR','PLN','QAR','RON','RSD','SAR','SBD','SCR','SEK','SGD','SHP','SLE','SOS','SRD','SZL','THB','TJS','TOP','TRY','TTD','TWD','TZS','UAH','USD','UYU','UZS','WST','YER','ZAR','ZMW'
]);

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

type LocalPayment={id:string;currency:string};

async function localPayment(stripePaymentIntentId:string):Promise<LocalPayment>{
  const result=await pool.query(`select id,currency from payment_intents where provider='stripe' and provider_intent_id=$1`,[stripePaymentIntentId]);
  if(!result.rowCount) throw new Error('payment_not_found');
  return {id:String(result.rows[0].id),currency:String(result.rows[0].currency).toUpperCase()};
}

function currencyExponent(currency:string){
  const code=currency.toUpperCase();
  if(ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if(THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  if(TWO_DECIMAL_CURRENCIES.has(code)) return 2;
  throw new Error('stripe_currency_unsupported');
}

export function stripeMinorToMajor(currency:string,value:number|undefined){
  if(value===undefined) return undefined;
  return value/(10**currencyExponent(currency));
}

function requireMatchingCurrency(localCurrency:string,stripeCurrency:string|undefined){
  if(!stripeCurrency) throw new Error('stripe_webhook_currency_missing');
  const normalized=stripeCurrency.toUpperCase();
  if(normalized!==localCurrency.toUpperCase()) throw new Error('stripe_webhook_currency_mismatch');
  return normalized;
}

export async function applyStripeWebhook(event:StripeEvent){
  const principal:Principal={role:'admin'};
  const object=event.data.object;
  if(event.type.startsWith('payment_intent.')){
    if(!object.id) throw new Error('stripe_webhook_payload_invalid');
    const payment=await localPayment(object.id);
    const currency=requireMatchingCurrency(payment.currency,object.currency);
    const payload={provider:'stripe',stripeEventType:event.type,stripeObjectId:object.id};
    switch(event.type){
      case 'payment_intent.requires_action': return updatePaymentState(principal,payment.id,'requires_action',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});
      case 'payment_intent.amount_capturable_updated': return updatePaymentState(principal,payment.id,'authorized',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});
      case 'payment_intent.succeeded': return updatePaymentState(principal,payment.id,'captured',{amount:stripeMinorToMajor(currency,object.amount_received??object.amount),providerEventId:event.id,payload});
      case 'payment_intent.canceled': return updatePaymentState(principal,payment.id,'cancelled',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});
      case 'payment_intent.payment_failed': return updatePaymentState(principal,payment.id,'failed',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});
      default:return null;
    }
  }
  if(event.type==='refund.created'){
    const stripeIntent=object.payment_intent;
    if(typeof stripeIntent!=='string'||object.amount===undefined) throw new Error('stripe_webhook_payload_invalid');
    const payment=await localPayment(stripeIntent);
    const currency=requireMatchingCurrency(payment.currency,object.currency);
    return refundPayment(principal,payment.id,stripeMinorToMajor(currency,object.amount)!,event.id,{provider:'stripe',stripeEventType:event.type,stripeObjectId:object.id});
  }
  return null;
}
