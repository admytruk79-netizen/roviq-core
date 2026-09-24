import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { createPaymentIntent } from './payment-core.js';
import { updatePaymentState } from './payment-state.js';

async function recordProviderCreateOutcome(paymentIntentId:string,outcome:'uncertain'|'failed',details:Record<string,unknown>){
  await pool.query(
    `update payment_intents
        set metadata=coalesce(metadata,'{}'::jsonb)||$2::jsonb,
            updated_at=now()
      where id=$1`,
    [paymentIntentId,JSON.stringify({providerCreateOutcome:outcome,providerCreateDetails:details,providerCreateUpdatedAt:new Date().toISOString()})]
  );
}

const ZERO_DECIMAL_CURRENCIES=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);
const THREE_DECIMAL_CURRENCIES=new Set(['BHD','JOD','KWD','OMR','TND']);

function toMinorUnits(amount:number,currency:string){
  const code=currency.toUpperCase();
  if(THREE_DECIMAL_CURRENCIES.has(code)) throw new Error('currency_precision_unsupported');
  const factor=ZERO_DECIMAL_CURRENCIES.has(code)?1:100;
  const minor=Math.round(amount*factor);
  if(!Number.isSafeInteger(minor)||minor<0||minor/factor!==amount) throw new Error('invalid_financial_amount');
  return minor;
}

export async function createStripePaymentIntent(principal:Principal,input:{
  caseId:string;
  amount:number;
  currency?:string;
  description?:string;
  idempotencyKey:string;
  metadata?:Record<string,unknown>;
}){
  const secret=process.env.STRIPE_SECRET_KEY;
  if(!secret) throw new Error('stripe_not_configured');
  const currency=(input.currency??'USD').toUpperCase();
  const local=await createPaymentIntent(principal,{
    caseId:input.caseId,
    amount:input.amount,
    currency,
    description:input.description,
    provider:'stripe',
    clientRequestId:input.idempotencyKey,
    metadata:{...(input.metadata??{}),providerCreation:'stripe_api'}
  });

  if(local.provider_intent_id){
    return {payment:local,clientSecret:null,reused:true};
  }
  if(['failed','cancelled'].includes(local.state)) throw new Error('payment_request_terminal');

  const body=new URLSearchParams({
    amount:String(toMinorUnits(input.amount,currency)),
    currency:currency.toLowerCase(),
    'automatic_payment_methods[enabled]':'true',
    'metadata[roviq_payment_intent_id]':local.id,
    'metadata[roviq_case_id]':input.caseId
  });
  if(input.description) body.set('description',input.description);

  let response:Response;
  try{
    response=await fetch('https://api.stripe.com/v1/payment_intents',{
      method:'POST',
      headers:{
        authorization:`Bearer ${secret}`,
        'content-type':'application/x-www-form-urlencoded',
        'idempotency-key':`roviq:${local.id}`
      },
      body:body.toString(),
      signal:AbortSignal.timeout(15000)
    });
  }catch(error){
    // A transport error is ambiguous: Stripe may have created the PaymentIntent even though
    // the response never reached us. Keep the local request retryable and preserve the same
    // Stripe idempotency key (roviq:<local id>) for the next attempt.
    await recordProviderCreateOutcome(local.id,'uncertain',{
      provider:'stripe',
      stage:'create',
      error:error instanceof Error?error.message:String(error)
    });
    throw new Error('stripe_request_uncertain');
  }

  const json=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok||typeof json.id!=='string'){
    if(response.status>=500){
      await recordProviderCreateOutcome(local.id,'uncertain',{provider:'stripe',stage:'create',httpStatus:response.status,response:json});
      const error=new Error('stripe_request_uncertain') as Error&{providerResponse?:unknown};
      error.providerResponse=json;
      throw error;
    }
    await updatePaymentState(principal,local.id,'failed',{payload:{provider:'stripe',stage:'create',httpStatus:response.status,response:json}});
    const error=new Error('stripe_payment_create_failed') as Error&{providerResponse?:unknown};
    error.providerResponse=json;
    throw error;
  }

  const providerIntentId=json.id as string;
  const updated=await pool.query(
    `update payment_intents
        set provider_intent_id=$2,
            metadata=coalesce(metadata,'{}'::jsonb)||$3::jsonb,
            updated_at=now()
      where id=$1
        and provider='stripe'
        and provider_intent_id is null
      returning *`,
    [local.id,providerIntentId,JSON.stringify({stripeStatus:json.status??null,providerCreateOutcome:'confirmed',providerCreateUpdatedAt:new Date().toISOString()})]
  );
  if(!updated.rowCount){
    const current=await pool.query('select * from payment_intents where id=$1',[local.id]);
    if(current.rows[0]?.provider_intent_id!==providerIntentId) throw new Error('provider_intent_conflict');
    return {payment:current.rows[0],clientSecret:typeof json.client_secret==='string'?json.client_secret:null,reused:true};
  }

  return {
    payment:updated.rows[0],
    clientSecret:typeof json.client_secret==='string'?json.client_secret:null,
    reused:false
  };
}
