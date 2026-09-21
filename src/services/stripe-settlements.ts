import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { createPayout, updatePayoutState } from './payment-core.js';

const ZERO_DECIMAL_CURRENCIES=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);
const THREE_DECIMAL_CURRENCIES=new Set(['BHD','JOD','KWD','OMR','TND']);

function toMinorUnits(amount:number,currency:string){
  const code=currency.toUpperCase();
  if(THREE_DECIMAL_CURRENCIES.has(code)) throw new Error('currency_precision_unsupported');
  const factor=ZERO_DECIMAL_CURRENCIES.has(code)?1:100;
  const minor=Math.round(amount*factor);
  if(!Number.isSafeInteger(minor)||minor<=0||minor/factor!==amount) throw new Error('invalid_financial_amount');
  return minor;
}

async function connectedAccountId(actorId:string){
  const result=await pool.query(
    `select attributes from actors where id=$1 and status='active'`,
    [actorId]
  );
  if(!result.rowCount) throw new Error('payout_counterparty_invalid');
  const attributes=result.rows[0].attributes??{};
  const value=attributes.stripeConnectedAccountId??attributes.stripe_connected_account_id;
  if(typeof value!=='string'||!value.startsWith('acct_')) throw new Error('stripe_connected_account_missing');
  return value;
}

export async function createStripePartnerSettlement(principal:Principal,input:{
  caseId:string;
  counterpartyActorId:string;
  paymentIntentId:string;
  amount:number;
  currency?:string;
  idempotencyKey:string;
  metadata?:Record<string,unknown>;
}){
  const secret=process.env.STRIPE_SECRET_KEY;
  if(!secret) throw new Error('stripe_not_configured');
  const currency=(input.currency??'USD').toUpperCase();
  const destination=await connectedAccountId(input.counterpartyActorId);

  const payout=await createPayout(principal,{
    caseId:input.caseId,
    counterpartyActorId:input.counterpartyActorId,
    paymentIntentId:input.paymentIntentId,
    amount:input.amount,
    currency,
    provider:'stripe',
    clientRequestId:input.idempotencyKey,
    metadata:{...(input.metadata??{}),providerRail:'stripe_connect_transfer',destination}
  });

  if(payout.provider_payout_id){
    return {payout,reused:true};
  }
  if(['paid','cancelled'].includes(payout.state)) throw new Error('payout_request_terminal');

  if(payout.state==='pending') await updatePayoutState(principal,payout.id,'approved');
  const refreshed=(await pool.query('select * from settlement_payouts where id=$1',[payout.id])).rows[0];
  if(refreshed.state==='approved') await updatePayoutState(principal,payout.id,'processing');

  const body=new URLSearchParams({
    amount:String(toMinorUnits(input.amount,currency)),
    currency:currency.toLowerCase(),
    destination,
    transfer_group:`roviq_case_${input.caseId}`,
    'metadata[roviq_payout_id]':payout.id,
    'metadata[roviq_case_id]':input.caseId,
    'metadata[roviq_counterparty_actor_id]':input.counterpartyActorId
  });

  let response:Response;
  try{
    response=await fetch('https://api.stripe.com/v1/transfers',{
      method:'POST',
      headers:{
        authorization:`Bearer ${secret}`,
        'content-type':'application/x-www-form-urlencoded',
        'idempotency-key':`roviq-payout:${payout.id}`
      },
      body:body.toString(),
      signal:AbortSignal.timeout(15000)
    });
  }catch(error){
    await updatePayoutState(principal,payout.id,'failed');
    throw new Error('stripe_settlement_request_failed');
  }

  const json=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok||typeof json.id!=='string'){
    await updatePayoutState(principal,payout.id,'failed');
    const error=new Error('stripe_settlement_create_failed') as Error&{providerResponse?:unknown};
    error.providerResponse=json;
    throw error;
  }

  const transferId=json.id as string;
  const current=(await pool.query('select state,provider_payout_id from settlement_payouts where id=$1',[payout.id])).rows[0];
  if(current.provider_payout_id&&current.provider_payout_id!==transferId) throw new Error('provider_payout_conflict');

  const paid=await updatePayoutState(principal,payout.id,'paid',transferId);
  await pool.query(
    `update settlement_payouts
        set metadata=coalesce(metadata,'{}'::jsonb)||$2::jsonb,updated_at=now()
      where id=$1`,
    [payout.id,JSON.stringify({
      providerRail:'stripe_connect_transfer',
      destination,
      transferId,
      providerStatus:json.object??'transfer'
    })]
  );
  return {payout:paid,reused:false};
}
