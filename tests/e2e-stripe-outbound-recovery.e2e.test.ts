import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createStripePaymentIntent } from '../src/services/stripe-payments.js';

const admin={role:'admin'} as const;

describe('Stripe outbound ambiguous-outcome recovery',()=>{
  let caseId:string;
  const previousSecret=process.env.STRIPE_SECRET_KEY;

  beforeAll(async()=>{
    process.env.STRIPE_SECRET_KEY='sk_test_integrity';
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,case_type,state)
       values($1,'maintenance','payment_pending') returning id`,
      [domain.rows[0].id]
    );
    caseId=serviceCase.rows[0].id;
  });

  afterEach(()=>{vi.unstubAllGlobals();});

  afterAll(async()=>{
    if(previousSecret===undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY=previousSecret;
    await pool.end();
  });

  it('keeps the canonical payment retryable after a network timeout and reuses the same Stripe idempotency key',async()=>{
    const requestKey=`stripe-ambiguous-${Date.now()}-${Math.random()}`;
    const firstFetch=vi.fn().mockRejectedValue(new Error('socket closed after write'));
    vi.stubGlobal('fetch',firstFetch);

    await expect(createStripePaymentIntent(admin,{
      caseId,
      amount:42.50,
      currency:'USD',
      idempotencyKey:requestKey,
      description:'Integrity retry proof'
    })).rejects.toThrow('stripe_request_uncertain');

    const local=await pool.query(
      `select id,state,provider_intent_id,metadata
         from payment_intents
        where provider='stripe' and client_request_id=$1`,
      [requestKey]
    );
    expect(local.rowCount).toBe(1);
    expect(local.rows[0].state).not.toBe('failed');
    expect(local.rows[0].provider_intent_id).toBeNull();
    expect(local.rows[0].metadata.providerCreateOutcome).toBe('uncertain');

    const firstHeaders=(firstFetch.mock.calls[0][1] as RequestInit).headers as Record<string,string>;
    const expectedIdempotency=`roviq:${local.rows[0].id}`;
    expect(firstHeaders['idempotency-key']).toBe(expectedIdempotency);

    const secondFetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id:'pi_integrity_retry',
      status:'requires_payment_method',
      client_secret:'pi_integrity_retry_secret'
    }),{status:200,headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',secondFetch);

    const retried=await createStripePaymentIntent(admin,{
      caseId,
      amount:42.50,
      currency:'USD',
      idempotencyKey:requestKey,
      description:'Integrity retry proof'
    });
    expect(retried.payment.id).toBe(local.rows[0].id);
    expect(retried.payment.provider_intent_id).toBe('pi_integrity_retry');

    const secondHeaders=(secondFetch.mock.calls[0][1] as RequestInit).headers as Record<string,string>;
    expect(secondHeaders['idempotency-key']).toBe(expectedIdempotency);

    const stored=await pool.query(`select state,metadata from payment_intents where id=$1`,[local.rows[0].id]);
    expect(stored.rows[0].state).not.toBe('failed');
    expect(stored.rows[0].metadata.providerCreateOutcome).toBe('confirmed');
  });
});
