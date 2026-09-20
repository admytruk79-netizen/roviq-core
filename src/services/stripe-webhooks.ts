import { createHmac,timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { refundPayment } from './payment-core.js';
import { updatePaymentState } from './payment-state.js';

const ZERO_DECIMAL_CURRENCIES=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);
const THREE_DECIMAL_CURRENCIES=new Set(['BHD','JOD','KWD','OMR','TND']);
const systemPrincipal={role:'admin'} as Principal;

function stripeAmount(amountMinor:unknown,currency:unknown){
  const code=String(currency??'USD').toUpperCase();
  if(THREE_DECIMAL_CURRENCIES.has(code)) throw new Error('currency_precision_unsupported');
  const minor=Number(amountMinor);
  if(!Number.isSafeInteger(minor)||minor<0) throw new Error('stripe_amount_invalid');
  return minor/(ZERO_DECIMAL_CURRENCIES.has(code)?1:100);
}

function parseStripeSignature(header:string){
  const parts=header.split(',').map((part)=>part.trim());
  const timestamp=parts.find((part)=>part.startsWith('t='))?.slice(2);
  const signatures=parts.filter((part)=>part.startsWith('v1=')).map((part)=>part.slice(3));
  if(!timestamp||signatures.length===0) throw new Error('stripe_signature_invalid');
  return {timestamp,signatures};
}

export function verifyStripeSignature(rawBody:Buffer,header:string,secret:string,nowSeconds=Math.floor(Date.now()/1000)){
  const {timestamp,signatures}=parseStripeSignature(header);
  const timestampNumber=Number(timestamp);
  if(!Number.isFinite(timestampNumber)||Math.abs(nowSeconds-timestampNumber)>300) throw new Error('stripe_signature_expired');
  const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const expectedBuffer=Buffer.from(expected,'hex');
  const valid=signatures.some((signature)=>{
    if(!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const candidate=Buffer.from(signature,'hex');
    return candidate.length===expectedBuffer.length&&timingSafeEqual(candidate,expectedBuffer);
  });
  if(!valid) throw new Error('stripe_signature_invalid');
}

async function markProviderEvent(providerEventId:string,state:'processed'|'ignored'|'failed',paymentIntentId:string|null,errorMessage?:string|null){
  await pool.query(
    `update payment_provider_events
        set processing_state=$2,
            related_payment_intent_id=coalesce($3,related_payment_intent_id),
            error_message=$4,
            processed_at=now()
      where provider='stripe' and provider_event_id=$1`,
    [providerEventId,state,paymentIntentId,errorMessage??null]
  );
}

async function findStripePayment(providerIntentId:string){
  const result=await pool.query(
    `select * from payment_intents
      where provider='stripe' and provider_intent_id=$1
      limit 1`,
    [providerIntentId]
  );
  return result.rows[0]??null;
}

export async function processStripeWebhook(rawBody:Buffer,signatureHeader:string|undefined){
  const secret=process.env.STRIPE_WEBHOOK_SECRET;
  if(!secret) throw new Error('stripe_webhook_not_configured');
  if(!signatureHeader) throw new Error('stripe_signature_required');
  verifyStripeSignature(rawBody,signatureHeader,secret);

  let event:any;
  try{event=JSON.parse(rawBody.toString('utf8'));}catch{throw new Error('stripe_payload_invalid');}
  if(!event||typeof event.id!=='string'||typeof event.type!=='string'||!event.data?.object) throw new Error('stripe_payload_invalid');

  const inserted=await pool.query(
    `insert into payment_provider_events(provider,provider_event_id,event_type,payload)
     values('stripe',$1,$2,$3)
     on conflict(provider,provider_event_id) do nothing
     returning *`,
    [event.id,event.type,JSON.stringify(event)]
  );
  if(!inserted.rowCount){
    const existing=await pool.query(
      `select provider_event_id,event_type,processing_state,related_payment_intent_id,error_message,received_at,processed_at
         from payment_provider_events where provider='stripe' and provider_event_id=$1`,
      [event.id]
    );
    return {duplicate:true,event:existing.rows[0]};
  }

  const object=event.data.object;
  let payment:any=null;
  try{
    if(event.type.startsWith('payment_intent.')){
      if(typeof object.id!=='string'){
        await markProviderEvent(event.id,'ignored',null,'payment_intent_id_missing');
        return {duplicate:false,ignored:true};
      }
      payment=await findStripePayment(object.id);
      if(!payment){
        await markProviderEvent(event.id,'ignored',null,'payment_intent_not_linked');
        return {duplicate:false,ignored:true};
      }

      if(event.type==='payment_intent.amount_capturable_updated'){
        await updatePaymentState(systemPrincipal,payment.id,'authorized',{providerEventId:event.id,payload:event});
      }else if(event.type==='payment_intent.succeeded'){
        const amount=stripeAmount(object.amount_received??object.amount,payment.currency);
        await updatePaymentState(systemPrincipal,payment.id,'captured',{amount,providerEventId:event.id,payload:event});
      }else if(event.type==='payment_intent.payment_failed'){
        await updatePaymentState(systemPrincipal,payment.id,'failed',{providerEventId:event.id,payload:event});
      }else if(event.type==='payment_intent.canceled'){
        await updatePaymentState(systemPrincipal,payment.id,'cancelled',{providerEventId:event.id,payload:event});
      }else{
        await markProviderEvent(event.id,'ignored',payment.id,'event_type_not_actionable');
        return {duplicate:false,ignored:true,paymentIntentId:payment.id};
      }
    }else if(event.type==='refund.created'){
      const providerIntentId=typeof object.payment_intent==='string'?object.payment_intent:null;
      if(!providerIntentId){
        await markProviderEvent(event.id,'ignored',null,'refund_payment_intent_missing');
        return {duplicate:false,ignored:true};
      }
      payment=await findStripePayment(providerIntentId);
      if(!payment){
        await markProviderEvent(event.id,'ignored',null,'payment_intent_not_linked');
        return {duplicate:false,ignored:true};
      }
      const amount=stripeAmount(object.amount,payment.currency);
      await refundPayment(systemPrincipal,payment.id,amount,event.id,event);
    }else{
      await markProviderEvent(event.id,'ignored',null,'event_type_not_actionable');
      return {duplicate:false,ignored:true};
    }

    await markProviderEvent(event.id,'processed',payment?.id??null);
    return {duplicate:false,processed:true,paymentIntentId:payment?.id??null};
  }catch(error){
    await markProviderEvent(event.id,'failed',payment?.id??null,error instanceof Error?error.message:String(error));
    throw error;
  }
}
