import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  createPaymentIntent,
  createPayout,
  refundPayment,
  updatePaymentState,
  updatePayoutState
} from '../src/services/payments.js';

const admin={role:'admin'} as const;

async function createCase(){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const customer=await pool.query(`insert into actors(actor_type,status) values('customer','active') returning id`);
  const serviceCase=await pool.query(`insert into service_cases(domain_id,case_type,state,customer_actor_id)
    values($1,'maintenance','provider_selection',$2) returning id`,[domain.rows[0].id,customer.rows[0].id]);
  return serviceCase.rows[0].id as string;
}

async function createPartner(){
  const partner=await pool.query(`insert into actors(actor_type,status) values('shop','active') returning id`);
  return partner.rows[0].id as string;
}

describe('financial provider replay and concurrency invariants',()=>{
  let caseId:string;
  let partnerActorId:string;

  beforeAll(async()=>{
    caseId=await createCase();
    partnerActorId=await createPartner();
  });

  afterAll(async()=>{await pool.end();});

  it('reuses the canonical payment intent for a matching provider reference and rejects incompatible reuse',async()=>{
    const providerIntentId=`pi-replay-${Date.now()}-${Math.random()}`;
    const first=await createPaymentIntent(admin,{caseId,amount:125,currency:'USD',provider:'test',providerIntentId});
    const replay=await createPaymentIntent(admin,{caseId,amount:125,currency:'USD',provider:'test',providerIntentId});
    expect(replay.id).toBe(first.id);

    await expect(createPaymentIntent(admin,{caseId,amount:126,currency:'USD',provider:'test',providerIntentId}))
      .rejects.toThrow('provider_intent_conflict');

    const count=await pool.query(`select count(*)::int as n from payment_intents where provider='test' and provider_intent_id=$1`,[providerIntentId]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('serializes a replayed capture event and emits one event and one ledger posting',async()=>{
    const payment=await createPaymentIntent(admin,{caseId,amount:200,currency:'USD'});
    const providerEventId=`evt-capture-${Date.now()}-${Math.random()}`;

    const results=await Promise.allSettled([
      updatePaymentState(admin,payment.id,'captured',{providerEventId}),
      updatePaymentState(admin,payment.id,'captured',{providerEventId})
    ]);
    expect(results.every(result=>result.status==='fulfilled')).toBe(true);

    const events=await pool.query(`select count(*)::int as n from payment_events where provider_event_id=$1`,[providerEventId]);
    const ledger=await pool.query(`select count(*)::int as n from ledger_entries where payment_intent_id=$1 and entry_type='payment_capture'`,[payment.id]);
    expect(Number(events.rows[0].n)).toBe(1);
    expect(Number(ledger.rows[0].n)).toBe(1);
  });

  it('rejects a provider event replayed against a different payment',async()=>{
    const first=await createPaymentIntent(admin,{caseId,amount:80,currency:'USD'});
    const second=await createPaymentIntent(admin,{caseId,amount:90,currency:'USD'});
    const providerEventId=`evt-conflict-${Date.now()}-${Math.random()}`;

    await updatePaymentState(admin,first.id,'authorized',{providerEventId});
    await expect(updatePaymentState(admin,second.id,'authorized',{providerEventId}))
      .rejects.toThrow('provider_event_conflict');
  });

  it('makes refund event replay idempotent without duplicating refund ledger entries',async()=>{
    const payment=await createPaymentIntent(admin,{caseId,amount:150,currency:'USD'});
    await updatePaymentState(admin,payment.id,'captured',{providerEventId:`evt-refund-capture-${Date.now()}-${Math.random()}`});
    const refundEventId=`evt-refund-${Date.now()}-${Math.random()}`;

    const first=await refundPayment(admin,payment.id,50,refundEventId);
    const replay=await refundPayment(admin,payment.id,50,refundEventId);
    expect(replay.id).toBe(first.id);

    const events=await pool.query(`select count(*)::int as n from payment_events where provider_event_id=$1`,[refundEventId]);
    const ledger=await pool.query(`select count(*)::int as n from ledger_entries where payment_intent_id=$1 and entry_type='refund' and external_reference=$2`,[payment.id,refundEventId]);
    expect(Number(events.rows[0].n)).toBe(1);
    expect(Number(ledger.rows[0].n)).toBe(1);
  });

  it('reuses provider payout references and posts a paid payout exactly once',async()=>{
    const payment=await createPaymentIntent(admin,{caseId,amount:110,currency:'USD'});
    await updatePaymentState(admin,payment.id,'captured',{providerEventId:`evt-payout-capture-${Date.now()}-${Math.random()}`});
    const providerPayoutId=`po-replay-${Date.now()}-${Math.random()}`;

    const payout=await createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,paymentIntentId:payment.id,
      amount:75,currency:'USD',provider:'test',providerPayoutId
    });
    const replay=await createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,paymentIntentId:payment.id,
      amount:75,currency:'USD',provider:'test',providerPayoutId
    });
    expect(replay.id).toBe(payout.id);

    await updatePayoutState(admin,payout.id,'approved');
    await updatePayoutState(admin,payout.id,'processing');
    await Promise.all([
      updatePayoutState(admin,payout.id,'paid',providerPayoutId),
      updatePayoutState(admin,payout.id,'paid',providerPayoutId)
    ]);

    const payouts=await pool.query(`select count(*)::int as n from settlement_payouts where provider='test' and provider_payout_id=$1`,[providerPayoutId]);
    const ledger=await pool.query(`select count(*)::int as n from ledger_entries where payout_id=$1 and entry_type='provider_payout'`,[payout.id]);
    expect(Number(payouts.rows[0].n)).toBe(1);
    expect(Number(ledger.rows[0].n)).toBe(1);
  });
});
