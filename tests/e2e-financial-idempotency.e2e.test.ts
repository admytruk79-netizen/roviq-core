import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  createPaymentIntent,
  createPayout,
  refundPayment,
  updatePaymentState,
  updatePayoutState
} from '../src/services/payments.js';
import { applyStripeWebhook } from '../src/services/stripe-webhook.js';

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


  it('reuses a payment for the same provider request key and rejects incompatible retries',async()=>{
    const clientRequestId=`payment-request-${Date.now()}-${Math.random()}`;
    const first=await createPaymentIntent(admin,{caseId,amount:77,currency:'USD',provider:'stripe',clientRequestId});
    const replay=await createPaymentIntent(admin,{caseId,amount:77,currency:'USD',provider:'stripe',clientRequestId});
    expect(replay.id).toBe(first.id);

    await expect(createPaymentIntent(admin,{caseId,amount:78,currency:'USD',provider:'stripe',clientRequestId}))
      .rejects.toThrow('payment_request_conflict');

    const count=await pool.query(
      `select count(*)::int as n from payment_intents where provider='stripe' and client_request_id=$1`,
      [clientRequestId]
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('rejects money that cannot be represented exactly by the current currency/storage contract',async()=>{
    await expect(createPaymentIntent(admin,{caseId,amount:10.005,currency:'USD'}))
      .rejects.toThrow('invalid_financial_amount');
    await expect(createPaymentIntent(admin,{caseId,amount:100.5,currency:'JPY'}))
      .rejects.toThrow('invalid_financial_amount');
    await expect(createPaymentIntent(admin,{caseId,amount:12.345,currency:'KWD'}))
      .rejects.toThrow('currency_precision_unsupported');

    const validUsd=await createPaymentIntent(admin,{caseId,amount:0.29,currency:'USD'});
    const validJpy=await createPaymentIntent(admin,{caseId,amount:101,currency:'JPY'});
    expect(Number(validUsd.amount)).toBe(0.29);
    expect(Number(validJpy.amount)).toBe(101);
  });

  it('serializes a replayed capture event and emits one event and one ledger posting',async()=>{
    const payment=await createPaymentIntent(admin,{caseId,amount:200,currency:'USD'});
    const providerEventId=`evt-capture-${Date.now()}-${Math.random()}`;

    const results=await Promise.allSettled([
      updatePaymentState(admin,payment.id,'captured',{providerEventId}),
      updatePaymentState(admin,payment.id,'captured',{providerEventId})
    ]);
    expect(results.every(result=>result.status==='fulfilled')).toBe(true);

    const events=await pool.query(`select count(*)::int as n from payment_events where provider='manual' and provider_event_id=$1`,[providerEventId]);
    const ledger=await pool.query(`select count(*)::int as n from ledger_entries where payment_intent_id=$1 and entry_type='payment_capture'`,[payment.id]);
    expect(Number(events.rows[0].n)).toBe(1);
    expect(Number(ledger.rows[0].n)).toBe(1);
  });

  it('keeps identical event IDs independent across provider namespaces',async()=>{
    const alpha=await createPaymentIntent(admin,{caseId,amount:81,currency:'USD',provider:'alpha'});
    const beta=await createPaymentIntent(admin,{caseId,amount:82,currency:'USD',provider:'beta'});
    const providerEventId=`evt-shared-${Date.now()}-${Math.random()}`;

    await updatePaymentState(admin,alpha.id,'authorized',{providerEventId});
    await updatePaymentState(admin,beta.id,'authorized',{providerEventId});

    const events=await pool.query(`select provider,payment_intent_id from payment_events where provider_event_id=$1 order by provider`,[providerEventId]);
    expect(events.rows).toEqual([
      expect.objectContaining({provider:'alpha',payment_intent_id:alpha.id}),
      expect.objectContaining({provider:'beta',payment_intent_id:beta.id})
    ]);
  });

  it('rejects a provider event replayed against a different payment in the same provider namespace',async()=>{
    const first=await createPaymentIntent(admin,{caseId,amount:80,currency:'USD',provider:'same-provider'});
    const second=await createPaymentIntent(admin,{caseId,amount:90,currency:'USD',provider:'same-provider'});
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

    const events=await pool.query(`select count(*)::int as n from payment_events where provider='manual' and provider_event_id=$1`,[refundEventId]);
    const ledger=await pool.query(`select count(*)::int as n from ledger_entries where payment_intent_id=$1 and entry_type='refund' and external_reference=$2`,[payment.id,refundEventId]);
    expect(Number(events.rows[0].n)).toBe(1);
    expect(Number(ledger.rows[0].n)).toBe(1);
  });



  it('replays a previously failed Stripe event after the local payment becomes linkable',async()=>{
    const providerIntentId=`pi-late-link-${Date.now()}-${Math.random()}`;
    const providerEventId=`evt-late-link-${Date.now()}-${Math.random()}`;
    const event={
      id:providerEventId,
      type:'payment_intent.succeeded',
      data:{object:{
        id:providerIntentId,
        amount:5000,
        amount_received:5000,
        currency:'usd'
      }}
    } as any;

    await expect(applyStripeWebhook(event)).rejects.toThrow('payment_not_found');
    const failed=await pool.query(
      `select processing_state,error_message from payment_provider_events
        where provider='stripe' and provider_event_id=$1`,
      [providerEventId]
    );
    expect(failed.rows[0].processing_state).toBe('failed');

    const payment=await createPaymentIntent(admin,{
      caseId,
      amount:50,
      currency:'USD',
      provider:'stripe',
      providerIntentId
    });
    const replayed=await applyStripeWebhook(event);
    expect(replayed.id).toBe(payment.id);
    expect(replayed.state).toBe('captured');

    const providerEvent=await pool.query(
      `select processing_state,error_message,related_payment_intent_id
         from payment_provider_events
        where provider='stripe' and provider_event_id=$1`,
      [providerEventId]
    );
    expect(providerEvent.rows[0]).toMatchObject({
      processing_state:'processed',
      error_message:null,
      related_payment_intent_id:payment.id
    });
    const ledger=await pool.query(
      `select count(*)::int as n from ledger_entries
        where payment_intent_id=$1 and entry_type='payment_capture'`,
      [payment.id]
    );
    expect(Number(ledger.rows[0].n)).toBe(1);
  });


  it('reclaims a stale processing Stripe event after a worker crash',async()=>{
    const providerIntentId=`pi-stale-claim-${Date.now()}-${Math.random()}`;
    const providerEventId=`evt-stale-claim-${Date.now()}-${Math.random()}`;
    const payment=await createPaymentIntent(admin,{
      caseId,
      amount:64,
      currency:'USD',
      provider:'stripe',
      providerIntentId
    });
    const event={
      id:providerEventId,
      type:'payment_intent.succeeded',
      data:{object:{
        id:providerIntentId,
        amount:6400,
        amount_received:6400,
        currency:'usd'
      }}
    } as any;

    await pool.query(
      `insert into payment_provider_events(
         provider,provider_event_id,event_type,processing_state,processing_started_at,attempt_count,payload
       ) values('stripe',$1,$2,'processing',now()-interval '6 minutes',1,$3)`,
      [providerEventId,event.type,JSON.stringify(event)]
    );

    const replayed=await applyStripeWebhook(event);
    expect(replayed.id).toBe(payment.id);
    expect(replayed.state).toBe('captured');

    const providerEvent=await pool.query(
      `select processing_state,processing_started_at,attempt_count,related_payment_intent_id,error_message
         from payment_provider_events
        where provider='stripe' and provider_event_id=$1`,
      [providerEventId]
    );
    expect(providerEvent.rows[0].processing_state).toBe('processed');
    expect(providerEvent.rows[0].processing_started_at).toBeNull();
    expect(Number(providerEvent.rows[0].attempt_count)).toBe(2);
    expect(providerEvent.rows[0].related_payment_intent_id).toBe(payment.id);
    expect(providerEvent.rows[0].error_message).toBeNull();

    const ledger=await pool.query(
      `select count(*)::int as n from ledger_entries
        where payment_intent_id=$1 and entry_type='payment_capture'`,
      [payment.id]
    );
    expect(Number(ledger.rows[0].n)).toBe(1);
  });

  it('serializes concurrent Stripe dispute-loss events to one chargeback ledger posting',async()=>{
    const providerIntentId=`pi-dispute-race-${Date.now()}-${Math.random()}`;
    const payment=await createPaymentIntent(admin,{
      caseId,amount:90,currency:'USD',provider:'stripe',providerIntentId
    });
    await updatePaymentState(admin,payment.id,'captured',{
      providerEventId:`evt-dispute-race-capture-${Date.now()}-${Math.random()}`
    });
    const disputeId=`dp-race-${Date.now()}-${Math.random()}`;
    const eventA={
      id:`evt-dispute-race-a-${Date.now()}-${Math.random()}`,
      type:'charge.dispute.closed',
      data:{object:{
        id:disputeId,payment_intent:providerIntentId,amount:9000,currency:'usd',
        status:'lost',reason:'fraudulent'
      }}
    } as any;
    const eventB={...eventA,id:`evt-dispute-race-b-${Date.now()}-${Math.random()}`};

    const results=await Promise.all([applyStripeWebhook(eventA),applyStripeWebhook(eventB)]);
    expect(results.every(Boolean)).toBe(true);

    const ledger=await pool.query(
      `select count(*)::int as n,coalesce(sum(amount),0)::numeric as amount
         from ledger_entries
        where payment_intent_id=$1
          and entry_type='payment_dispute_loss'
          and external_reference=$2`,
      [payment.id,disputeId]
    );
    expect(Number(ledger.rows[0].n)).toBe(1);
    expect(Number(ledger.rows[0].amount)).toBe(-90);

    const providerEvents=await pool.query(
      `select processing_state,count(*)::int as n
         from payment_provider_events
        where provider='stripe' and provider_event_id in ($1,$2)
        group by processing_state`,
      [eventA.id,eventB.id]
    );
    expect(providerEvents.rows).toEqual([expect.objectContaining({processing_state:'processed',n:2})]);
  });

  it('persists Stripe disputes idempotently and posts a loss once',async()=>{
    const providerIntentId=`pi-dispute-${Date.now()}-${Math.random()}`;
    const payment=await createPaymentIntent(admin,{
      caseId,amount:50,currency:'USD',provider:'stripe',providerIntentId
    });
    await updatePaymentState(admin,payment.id,'captured',{providerEventId:`evt-dispute-capture-${Date.now()}-${Math.random()}`});

    const disputeId=`dp-${Date.now()}-${Math.random()}`;
    await applyStripeWebhook({
      id:`evt-dispute-open-${Date.now()}-${Math.random()}`,
      type:'charge.dispute.created',
      data:{object:{
        id:disputeId,payment_intent:providerIntentId,amount:5000,currency:'usd',
        status:'needs_response',reason:'fraudulent'
      }}
    } as any);

    const opened=await pool.query(`select status,amount_minor from payment_disputes where provider='stripe' and external_reference=$1`,[disputeId]);
    expect(opened.rows[0].status).toBe('needs_response');
    expect(Number(opened.rows[0].amount_minor)).toBe(5000);

    const lostEventId=`evt-dispute-lost-${Date.now()}-${Math.random()}`;
    const lostEvent={
      id:lostEventId,
      type:'charge.dispute.closed',
      data:{object:{
        id:disputeId,payment_intent:providerIntentId,amount:5000,currency:'usd',
        status:'lost',reason:'fraudulent'
      }}
    } as any;
    await applyStripeWebhook(lostEvent);
    await applyStripeWebhook(lostEvent);

    const dispute=await pool.query(`select status from payment_disputes where provider='stripe' and external_reference=$1`,[disputeId]);
    const ledger=await pool.query(
      `select count(*)::int as n,coalesce(sum(amount),0)::numeric as amount
         from ledger_entries
        where payment_intent_id=$1 and entry_type='payment_dispute_loss' and external_reference=$2`,
      [payment.id,disputeId]
    );
    const providerEvents=await pool.query(
      `select count(*)::int as n from payment_provider_events where provider='stripe' and provider_event_id=$1`,
      [lostEventId]
    );
    expect(dispute.rows[0].status).toBe('lost');
    expect(Number(ledger.rows[0].n)).toBe(1);
    expect(Number(ledger.rows[0].amount)).toBe(-50);
    expect(Number(providerEvents.rows[0].n)).toBe(1);
  });


  it('reuses the same settlement payout for a matching provider request key',async()=>{
    const payment=await createPaymentIntent(admin,{caseId,amount:140,currency:'USD'});
    await updatePaymentState(admin,payment.id,'captured',{providerEventId:`evt-settlement-request-${Date.now()}-${Math.random()}`});
    const clientRequestId=`settlement-request-${Date.now()}-${Math.random()}`;

    const first=await createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,paymentIntentId:payment.id,
      amount:60,currency:'USD',provider:'stripe',clientRequestId
    });
    const replay=await createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,paymentIntentId:payment.id,
      amount:60,currency:'USD',provider:'stripe',clientRequestId
    });
    expect(replay.id).toBe(first.id);

    await expect(createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,paymentIntentId:payment.id,
      amount:61,currency:'USD',provider:'stripe',clientRequestId
    })).rejects.toThrow('payout_request_conflict');

    const count=await pool.query(
      `select count(*)::int as n from settlement_payouts where provider='stripe' and client_request_id=$1`,
      [clientRequestId]
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('requires provider proof before a non-manual payout can become paid',async()=>{
    const payout=await createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,amount:25,currency:'USD',provider:'test'
    });
    await updatePayoutState(admin,payout.id,'approved');
    await updatePayoutState(admin,payout.id,'processing');

    await expect(updatePayoutState(admin,payout.id,'paid'))
      .rejects.toThrow('payout_provider_reference_required');

    const paid=await updatePayoutState(admin,payout.id,'paid',`po-proof-${Date.now()}-${Math.random()}`);
    expect(paid.state).toBe('paid');
    expect(paid.provider_payout_id).toBeTruthy();
  });

  it('reuses provider payout references only when every canonical financial detail matches',async()=>{
    const payment=await createPaymentIntent(admin,{caseId,amount:110,currency:'USD'});
    const alternatePayment=await createPaymentIntent(admin,{caseId,amount:110,currency:'USD'});
    await updatePaymentState(admin,payment.id,'captured',{providerEventId:`evt-payout-capture-${Date.now()}-${Math.random()}`});
    await updatePaymentState(admin,alternatePayment.id,'captured',{providerEventId:`evt-payout-alt-capture-${Date.now()}-${Math.random()}`});
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

    await expect(createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,paymentIntentId:alternatePayment.id,
      amount:75,currency:'USD',provider:'test',providerPayoutId
    })).rejects.toThrow('provider_payout_conflict');

    await expect(createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,paymentIntentId:payment.id,
      amount:75,currency:'EUR',provider:'test',providerPayoutId
    })).rejects.toThrow('payout_currency_mismatch');

    await expect(createPayout(admin,{
      caseId,counterpartyActorId:partnerActorId,
      amount:75,currency:'USD',provider:'test',providerPayoutId
    })).rejects.toThrow('provider_payout_conflict');

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
