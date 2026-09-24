import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createStripePaymentIntent } from '../src/services/stripe-payments.js';

const admin={role:'admin'} as const;
const previousSecret=process.env.STRIPE_SECRET_KEY;

describe('Stripe outbound ambiguous-outcome recovery',()=>{
  let caseId:string;

  beforeAll(async()=>{
    process.env.STRIPE_SECRET_KEY='sk_test_recovery_only';
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const customer=await pool.query(`insert into actors(actor_type,status) values('customer','active') returning id`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,case_type,state,customer_actor_id)
       values($1,'maintenance','payment_pending',$2) returning id`,
      [domain.rows[0].id,customer.rows[0].id]
    );
    caseId=serviceCase.rows[0].id;
  });

  afterEach(()=>{vi.restoreAllMocks();});

  afterAll(async()=>{
    if(previousSecret===undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY=previousSecret;
    await pool.end();
  });

  it('keeps the same local request retryable after a network timeout and reuses the same Stripe idempotency key',async()=>{
    const idempotencyKey=`stripe-uncertain-${Date.now()}-${Math.random()}`;
    const fetchMock=vi.spyOn(globalThis,'fetch');
    fetchMock.mockRejectedValueOnce(new Error('socket_reset_after_send'));

    await expect(createStripePaymentIntent(admin,{
      caseId,
      amount:42.50,
      currency:'USD',
      idempotencyKey
    })).rejects.toThrow('stripe_request_uncertain');

    const local=await pool.query(
      `select id,state,provider_intent_id,metadata
         from payment_intents
        where provider='stripe' and client_request_id=$1`,
      [idempotencyKey]
    );
    expect(local.rowCount).toBe(1);
    expect(local.rows[0].state).not.toBe('failed');
    expect(local.rows[0].provider_intent_id).toBeNull();
    expect(local.rows[0].metadata.providerCreateOutcome).toBe('uncertain');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id:'pi_recovered_after_timeout',
      status:'requires_payment_method',
      client_secret:'pi_recovered_after_timeout_secret'
    }),{status:200,headers:{'content-type':'application/json'}}));

    const recovered=await createStripePaymentIntent(admin,{
      caseId,
      amount:42.50,
      currency:'USD',
      idempotencyKey
    });
    expect(recovered.payment.id).toBe(local.rows[0].id);
    expect(recovered.payment.provider_intent_id).toBe('pi_recovered_after_timeout');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders=fetchMock.mock.calls[0][1]?.headers as Record<string,string>;
    const secondHeaders=fetchMock.mock.calls[1][1]?.headers as Record<string,string>;
    expect(firstHeaders['idempotency-key']).toBe(`roviq:${local.rows[0].id}`);
    expect(secondHeaders['idempotency-key']).toBe(`roviq:${local.rows[0].id}`);

    const final=await pool.query(`select state,metadata from payment_intents where id=$1`,[local.rows[0].id]);
    expect(final.rows[0].state).not.toBe('failed');
    expect(final.rows[0].metadata.providerCreateOutcome).toBe('confirmed');
  });

  it('keeps Stripe 5xx responses retryable but treats definitive 4xx responses as terminal',async()=>{
    const fetchMock=vi.spyOn(globalThis,'fetch');
    const retryKey=`stripe-5xx-${Date.now()}-${Math.random()}`;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:{message:'temporary'}}),{
      status:503,headers:{'content-type':'application/json'}
    }));

    await expect(createStripePaymentIntent(admin,{caseId,amount:31,currency:'USD',idempotencyKey:retryKey}))
      .rejects.toThrow('stripe_request_uncertain');
    const retryable=await pool.query(
      `select state,metadata from payment_intents where provider='stripe' and client_request_id=$1`,
      [retryKey]
    );
    expect(retryable.rows[0].state).not.toBe('failed');
    expect(retryable.rows[0].metadata.providerCreateOutcome).toBe('uncertain');

    const terminalKey=`stripe-4xx-${Date.now()}-${Math.random()}`;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:{message:'bad request'}}),{
      status:400,headers:{'content-type':'application/json'}
    }));
    await expect(createStripePaymentIntent(admin,{caseId,amount:32,currency:'USD',idempotencyKey:terminalKey}))
      .rejects.toThrow('stripe_payment_create_failed');
    const terminal=await pool.query(
      `select state from payment_intents where provider='stripe' and client_request_id=$1`,
      [terminalKey]
    );
    expect(terminal.rows[0].state).toBe('failed');
  });
});
