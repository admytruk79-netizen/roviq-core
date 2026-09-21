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
  status?:string;
  reason?:string;
  evidence_details?:{due_by?:number|null};
};
type StripeEvent={id:string;type:string;data:{object:StripeObject}};

const ZERO_DECIMAL_CURRENCIES=new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'
]);
const THREE_DECIMAL_CURRENCIES=new Set(['BHD','JOD','KWD','OMR','TND']);
const TWO_DECIMAL_CURRENCIES=new Set([
  'AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BGN','BMD','BND','BOB','BRL','BSD','BWP','BYN','BZD','CAD','CDF','CHF','CNY','COP','CRC','CVE','CZK','DKK','DOP','DZD','EGP','ETB','EUR','FJD','FKP','GBP','GEL','GIP','GMD','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','ISK','JMD','KES','KGS','KHR','KYD','KZT','LAK','LBP','LKR','LRD','LSL','MAD','MDL','MKD','MMK','MNT','MOP','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','PAB','PEN','PGK','PHP','PKR','PLN','QAR','RON','RSD','SAR','SBD','SCR','SEK','SGD','SHP','SLE','SOS','SRD','SZL','THB','TJS','TOP','TRY','TTD','TWD','TZS','UAH','USD','UYU','UZS','WST','YER','ZAR','ZMW'
]);

const SUPPORTED_PAYMENT_INTENT_EVENTS=new Set([
  'payment_intent.requires_action',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.canceled',
  'payment_intent.payment_failed'
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

type LocalPayment={id:string;currency:string;caseId:string};

async function localPayment(stripePaymentIntentId:string):Promise<LocalPayment>{
  const result=await pool.query(`select id,currency,case_id from payment_intents where provider='stripe' and provider_intent_id=$1`,[stripePaymentIntentId]);
  if(!result.rowCount) throw new Error('payment_not_found');
  return {id:String(result.rows[0].id),currency:String(result.rows[0].currency).toUpperCase(),caseId:String(result.rows[0].case_id)};
}

function currencyExponent(currency:string){
  const code=currency.toUpperCase();
  if(ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if(THREE_DECIMAL_CURRENCIES.has(code)) throw new Error('stripe_currency_precision_unsupported');
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


async function beginProviderEvent(event:StripeEvent){
  const inserted=await pool.query(
    `insert into payment_provider_events(provider,provider_event_id,event_type,payload)
     values('stripe',$1,$2,$3)
     on conflict(provider,provider_event_id) do nothing
     returning id`,
    [event.id,event.type,JSON.stringify(event)]
  );
  if(inserted.rowCount) return true;

  const retry=await pool.query(
    `update payment_provider_events
        set processing_state='received',
            event_type=$2,
            payload=$3,
            error_message=null,
            processed_at=null
      where provider='stripe'
        and provider_event_id=$1
        and processing_state='failed'
      returning id`,
    [event.id,event.type,JSON.stringify(event)]
  );
  return Boolean(retry.rowCount);
}

async function finishProviderEvent(eventId:string,state:'processed'|'ignored'|'failed',paymentIntentId:string|null,errorMessage:string|null=null){
  await pool.query(
    `update payment_provider_events
        set processing_state=$2,
            related_payment_intent_id=coalesce($3,related_payment_intent_id),
            error_message=$4,
            processed_at=now()
      where provider='stripe' and provider_event_id=$1`,
    [eventId,state,paymentIntentId,errorMessage]
  );
}

function disputeState(status:string|undefined){
  if(status==='won'||status==='lost'||status==='under_review'||status==='warning_closed') return status;
  if(status==='warning_under_review') return 'under_review';
  if(status==='warning_needs_response'||status==='needs_response') return 'needs_response';
  if(status==='warning_won') return 'won';
  if(status==='warning_lost') return 'lost';
  return 'needs_response';
}

async function applyStripeDispute(event:StripeEvent,object:StripeObject){
  if(!object.id||typeof object.payment_intent!=='string'||object.amount===undefined) throw new Error('stripe_webhook_payload_invalid');
  const payment=await localPayment(object.payment_intent);
  const currency=requireMatchingCurrency(payment.currency,object.currency);
  const amountMinor=Number(object.amount);
  if(!Number.isSafeInteger(amountMinor)||amountMinor<=0) throw new Error('stripe_webhook_payload_invalid');
  const amount=stripeMinorToMajor(currency,amountMinor)!;
  const state=disputeState(object.status);
  const dueAt=object.evidence_details?.due_by
    ? new Date(object.evidence_details.due_by*1000).toISOString()
    : null;
  const dispute=await pool.query(
    `insert into payment_disputes(
       payment_intent_id,provider,external_reference,status,amount_minor,currency,reason,evidence_due_at,metadata,resolved_at
     ) values($1,'stripe',$2,$3,$4,$5,$6,$7,$8,case when $3 in ('won','lost','warning_closed') then now() else null end)
     on conflict(provider,external_reference)
     do update set status=excluded.status,reason=excluded.reason,evidence_due_at=excluded.evidence_due_at,
       metadata=payment_disputes.metadata||excluded.metadata,
       resolved_at=case when excluded.status in ('won','lost','warning_closed') then coalesce(payment_disputes.resolved_at,now()) else null end
     returning *`,
    [payment.id,object.id,state,amountMinor,currency,object.reason??null,dueAt,JSON.stringify({stripeEventId:event.id,stripeEventType:event.type})]
  );

  if(state==='lost'){
    await pool.query(
      `insert into ledger_entries(case_id,payment_intent_id,entry_type,account_code,amount,currency,state,external_reference,metadata)
       select $1,$2,'payment_dispute_loss','chargeback_loss',$3,$4,'posted',$5,$6
       where not exists(
         select 1 from ledger_entries
          where payment_intent_id=$2 and entry_type='payment_dispute_loss' and external_reference=$5
       )`,
      [payment.caseId,payment.id,-Math.abs(amount),currency,object.id,JSON.stringify({provider:'stripe',reason:object.reason??null})]
    );
  }

  await pool.query(
    `insert into events(aggregate_type,aggregate_id,event_type,actor_role,payload)
     values('service_case',$1,$2,'admin',$3)`,
    [
      payment.caseId,
      state==='lost'?'PAYMENT_DISPUTE_LOST':state==='won'||state==='warning_closed'?'PAYMENT_DISPUTE_CLOSED':'PAYMENT_DISPUTE_UPDATED',
      JSON.stringify({paymentIntentId:payment.id,providerDisputeId:object.id,amount,currency,state,reason:object.reason??null,evidenceDueAt:dueAt})
    ]
  );
  return dispute.rows[0];
}

export async function applyStripeWebhook(event:StripeEvent){
  const principal:Principal={role:'admin'};
  const object=event.data.object;
  const actionable=
    (event.type.startsWith('payment_intent.')&&SUPPORTED_PAYMENT_INTENT_EVENTS.has(event.type))
    || event.type==='refund.created'
    || ['charge.dispute.created','charge.dispute.updated','charge.dispute.closed'].includes(event.type);
  if(!actionable) return null;
  if(!await beginProviderEvent(event)) return null;
  let relatedPaymentId:string|null=null;

  try{
  if(event.type.startsWith('payment_intent.')){
    if(!object.id) throw new Error('stripe_webhook_payload_invalid');
    const payment=await localPayment(object.id);
    relatedPaymentId=payment.id;
    const currency=requireMatchingCurrency(payment.currency,object.currency);
    const payload={provider:'stripe',stripeEventType:event.type,stripeObjectId:object.id};
    switch(event.type){
      case 'payment_intent.requires_action': {const result=await updatePaymentState(principal,payment.id,'requires_action',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});await finishProviderEvent(event.id,'processed',payment.id);return result;}
      case 'payment_intent.amount_capturable_updated': {const result=await updatePaymentState(principal,payment.id,'authorized',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});await finishProviderEvent(event.id,'processed',payment.id);return result;}
      case 'payment_intent.succeeded': {const result=await updatePaymentState(principal,payment.id,'captured',{amount:stripeMinorToMajor(currency,object.amount_received??object.amount),providerEventId:event.id,payload});await finishProviderEvent(event.id,'processed',payment.id);return result;}
      case 'payment_intent.canceled': {const result=await updatePaymentState(principal,payment.id,'cancelled',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});await finishProviderEvent(event.id,'processed',payment.id);return result;}
      case 'payment_intent.payment_failed': {const result=await updatePaymentState(principal,payment.id,'failed',{amount:stripeMinorToMajor(currency,object.amount),providerEventId:event.id,payload});await finishProviderEvent(event.id,'processed',payment.id);return result;}
      default:return null;
    }
  }

  if(event.type==='refund.created'){
    const stripeIntent=object.payment_intent;
    if(typeof stripeIntent!=='string'||object.amount===undefined) throw new Error('stripe_webhook_payload_invalid');
    const payment=await localPayment(stripeIntent);
    relatedPaymentId=payment.id;
    const currency=requireMatchingCurrency(payment.currency,object.currency);
    const result=await refundPayment(principal,payment.id,stripeMinorToMajor(currency,object.amount)!,event.id,{provider:'stripe',stripeEventType:event.type,stripeObjectId:object.id});
    await finishProviderEvent(event.id,'processed',payment.id);
    return result;
  }
  if(['charge.dispute.created','charge.dispute.updated','charge.dispute.closed'].includes(event.type)){
    const dispute=await applyStripeDispute(event,object);
    relatedPaymentId=dispute.payment_intent_id;
    await finishProviderEvent(event.id,'processed',relatedPaymentId);
    return dispute;
  }
  await finishProviderEvent(event.id,'ignored',relatedPaymentId,'event_type_not_actionable');
  return null;
  }catch(error){
    await finishProviderEvent(event.id,'failed',relatedPaymentId,error instanceof Error?error.message:String(error));
    throw error;
  }
}
