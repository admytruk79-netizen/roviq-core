import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent, finalizeExternalCaseTransition, transitionCase } from './orchestration.js';
import { audit } from './audit.js';
import { setCustomerSnapshot } from './operations.js';

function amountEquals(a:unknown,b:unknown){
  return Number(a)===Number(b);
}

async function existingProviderEvent(providerEventId:string|undefined){
  if(!providerEventId)return null;
  const existing=await pool.query(`select payment_intent_id,event_type,amount from payment_events where provider_event_id=$1`,[providerEventId]);
  return existing.rows[0]??null;
}

export async function createPaymentIntent(principal: Principal, input:{ caseId:string; amount:number; currency?:string; description?:string; provider?:string; providerIntentId?:string; metadata?:Record<string,unknown> }) {
  const client=await pool.connect();
  try{
    await client.query('begin');
    const c = await client.query('select * from service_cases where id=$1 for update',[input.caseId]);
    if (!c.rowCount) throw new Error('case_not_found');
    const customerActorId = c.rows[0].customer_actor_id ?? null;

    const plan = await client.query('select id,current_revision from service_plans where case_id=$1',[input.caseId]);
    if (plan.rowCount) {
      const approval = await client.query(
        `select state from case_approvals where case_id=$1 and service_plan_id=$2 and revision=$3 and approval_type='quote'
         order by created_at desc limit 1`,
        [input.caseId,plan.rows[0].id,plan.rows[0].current_revision]
      );
      if (!approval.rowCount || approval.rows[0].state !== 'approved') throw new Error('quote_not_approved');
    }

    if(input.providerIntentId){
      const existing=await client.query(`select * from payment_intents where provider=$1 and provider_intent_id=$2`,[input.provider??'manual',input.providerIntentId]);
      if(existing.rowCount){
        const row=existing.rows[0];
        if(row.case_id!==input.caseId||!amountEquals(row.amount,input.amount)||row.currency!==(input.currency??'USD').toUpperCase()) throw new Error('provider_intent_conflict');
        await client.query('commit');
        return row;
      }
    }

    const r = await client.query(
      `insert into payment_intents(case_id,customer_actor_id,provider,provider_intent_id,amount,currency,description,metadata)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [input.caseId,customerActorId,input.provider ?? 'manual',input.providerIntentId ?? null,input.amount,(input.currency ?? 'USD').toUpperCase(),input.description ?? null,JSON.stringify(input.metadata ?? {})]
    );
    const p = r.rows[0];
    await appendCaseEvent(input.caseId,'PAYMENT_INTENT_CREATED',principal,{ paymentIntentId:p.id, amount:p.amount, currency:p.currency },client);
    await client.query('commit');
    await audit(principal,'create_payment_intent','payment_intent',p.id,'case_payment',{ caseId:input.caseId, amount:input.amount });
    return p;
  }catch(error){
    await client.query('rollback');
    throw error;
  }finally{client.release();}
}

export async function updatePaymentState(principal: Principal, paymentIntentId:string, nextState:'requires_action'|'authorized'|'captured'|'cancelled'|'failed', input:{ amount?:number; providerEventId?:string; payload?:Record<string,unknown> }={}) {
  const preview=await pool.query('select case_id from payment_intents where id=$1',[paymentIntentId]);
  if(!preview.rowCount) throw new Error('payment_not_found');
  const client = await pool.connect();
  let transitioned=false;
  try {
    await client.query('begin');
    const caseLock=await client.query('select id,state from service_cases where id=$1 for update',[preview.rows[0].case_id]);
    if(!caseLock.rowCount) throw new Error('case_not_found');
    const current = await client.query('select * from payment_intents where id=$1 for update',[paymentIntentId]);
    if (!current.rowCount) throw new Error('payment_not_found');
    const p = current.rows[0];

    if(input.providerEventId){
      const prior=await client.query(`select payment_intent_id,event_type,amount from payment_events where provider_event_id=$1`,[input.providerEventId]);
      if(prior.rowCount){
        const event=prior.rows[0];
        if(event.payment_intent_id!==paymentIntentId||event.event_type!==nextState.toUpperCase()||(input.amount!==undefined&&event.amount!==null&&!amountEquals(event.amount,input.amount))) throw new Error('provider_event_conflict');
        await client.query('commit');
        return p;
      }
    }

    if(p.state===nextState){
      await client.query('commit');
      return p;
    }
    const allowed:Record<string,string[]> = {
      created:['requires_action','authorized','captured','cancelled','failed'],
      requires_action:['authorized','captured','cancelled','failed'],
      authorized:['captured','cancelled','failed'],
      captured:[], cancelled:[], failed:[], partially_refunded:[], refunded:[]
    };
    if (!allowed[p.state]?.includes(nextState)) throw new Error('invalid_payment_transition');
    const stamp = nextState === 'authorized' ? ',authorized_at=now()' : nextState === 'captured' ? ',captured_at=now()' : nextState === 'cancelled' ? ',cancelled_at=now()' : '';
    const updated = await client.query(`update payment_intents set state=$1,updated_at=now() ${stamp} where id=$2 returning *`,[nextState,paymentIntentId]);
    await client.query(`insert into payment_events(payment_intent_id,event_type,amount,provider_event_id,payload) values($1,$2,$3,$4,$5)`,[paymentIntentId,nextState.toUpperCase(),input.amount ?? null,input.providerEventId ?? null,JSON.stringify(input.payload ?? {})]);
    if (nextState === 'captured') {
      await client.query(`insert into ledger_entries(case_id,payment_intent_id,entry_type,account_code,amount,currency,state,external_reference,metadata) values($1,$2,'payment_capture','customer_receivable',$3,$4,'posted',$5,$6)`,[p.case_id,paymentIntentId,input.amount ?? p.amount,p.currency,input.providerEventId ?? null,JSON.stringify({ provider:p.provider })]);
    }
    await appendCaseEvent(p.case_id,`PAYMENT_${nextState.toUpperCase()}`,principal,{ paymentIntentId, amount:input.amount ?? p.amount },client);
    if(nextState==='captured'&&caseLock.rows[0].state==='payment_pending'){
      await transitionCase(principal,p.case_id,'completed',{paymentIntentId},client);
      transitioned=true;
    }
    await client.query('commit');

    if (nextState === 'captured') {
      await setCustomerSnapshot(p.case_id,'payment_received','Payment received. Finalizing your service journey.','Completion');
      if(transitioned) await finalizeExternalCaseTransition(principal,p.case_id,'payment_pending','completed',{paymentIntentId});
    }
    await audit(principal,'payment_state_change','payment_intent',paymentIntentId,`${p.state}->${nextState}`);
    return updated.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

export async function refundPayment(principal: Principal, paymentIntentId:string, amount:number, providerEventId?:string, payload:Record<string,unknown>={}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from payment_intents where id=$1 for update',[paymentIntentId]);
    if (!current.rowCount) throw new Error('payment_not_found');
    const p = current.rows[0];
    if(providerEventId){
      const prior=await client.query(`select payment_intent_id,event_type,amount from payment_events where provider_event_id=$1`,[providerEventId]);
      if(prior.rowCount){
        const event=prior.rows[0];
        if(event.payment_intent_id!==paymentIntentId||event.event_type!=='REFUND'||!amountEquals(event.amount,amount)) throw new Error('provider_event_conflict');
        await client.query('commit');
        return p;
      }
    }
    if (!['captured','partially_refunded'].includes(p.state)) throw new Error('refund_not_allowed');
    const refunded = await client.query(`select coalesce(sum(amount),0)::numeric as amount from payment_events where payment_intent_id=$1 and event_type='REFUND'`,[paymentIntentId]);
    const totalRefunded = Number(refunded.rows[0].amount) + amount;
    if (amount <= 0 || totalRefunded > Number(p.amount)) throw new Error('invalid_refund_amount');
    const nextState = totalRefunded === Number(p.amount) ? 'refunded' : 'partially_refunded';
    const updated = await client.query('update payment_intents set state=$1,updated_at=now() where id=$2 returning *',[nextState,paymentIntentId]);
    await client.query(`insert into payment_events(payment_intent_id,event_type,amount,provider_event_id,payload) values($1,'REFUND',$2,$3,$4)`,[paymentIntentId,amount,providerEventId ?? null,JSON.stringify(payload)]);
    await client.query(`insert into ledger_entries(case_id,payment_intent_id,entry_type,account_code,amount,currency,state,external_reference,metadata) values($1,$2,'refund','customer_refund',$3,$4,'posted',$5,$6)`,[p.case_id,paymentIntentId,-Math.abs(amount),p.currency,providerEventId ?? null,JSON.stringify({ provider:p.provider })]);
    await appendCaseEvent(p.case_id,'PAYMENT_REFUNDED',principal,{ paymentIntentId, amount, state:nextState },client);
    await client.query('commit');
    await audit(principal,'refund_payment','payment_intent',paymentIntentId,'refund',{ amount });
    return updated.rows[0];
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
}

export async function createPayout(principal: Principal, input:{ caseId:string; counterpartyActorId:string; paymentIntentId?:string; amount:number; currency?:string; provider?:string; providerPayoutId?:string; metadata?:Record<string,unknown> }) {
  const client=await pool.connect();
  try{
    await client.query('begin');
    const serviceCase=await client.query('select id from service_cases where id=$1 for update',[input.caseId]);
    if(!serviceCase.rowCount) throw new Error('case_not_found');
    const actor=await client.query(`select id,status from actors where id=$1`,[input.counterpartyActorId]);
    if(!actor.rowCount||actor.rows[0].status!=='active') throw new Error('payout_counterparty_invalid');
    if(input.paymentIntentId){
      const payment=await client.query(`select case_id,currency from payment_intents where id=$1`,[input.paymentIntentId]);
      if(!payment.rowCount) throw new Error('payment_not_found');
      if(payment.rows[0].case_id!==input.caseId) throw new Error('payout_payment_case_mismatch');
      if(payment.rows[0].currency!==(input.currency??'USD').toUpperCase()) throw new Error('payout_currency_mismatch');
    }
    if(input.providerPayoutId){
      const existing=await client.query(`select * from settlement_payouts where provider=$1 and provider_payout_id=$2`,[input.provider??'manual',input.providerPayoutId]);
      if(existing.rowCount){
        const row=existing.rows[0];
        if(row.case_id!==input.caseId||row.counterparty_actor_id!==input.counterpartyActorId||!amountEquals(row.amount,input.amount)) throw new Error('provider_payout_conflict');
        await client.query('commit');
        return row;
      }
    }
    const r = await client.query(`insert into settlement_payouts(case_id,counterparty_actor_id,payment_intent_id,amount,currency,provider,provider_payout_id,metadata) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[input.caseId,input.counterpartyActorId,input.paymentIntentId ?? null,input.amount,(input.currency ?? 'USD').toUpperCase(),input.provider ?? 'manual',input.providerPayoutId ?? null,JSON.stringify(input.metadata ?? {})]);
    const payout = r.rows[0];
    await appendCaseEvent(input.caseId,'PAYOUT_CREATED',principal,{ payoutId:payout.id, counterpartyActorId:input.counterpartyActorId, amount:input.amount },client);
    await client.query('commit');
    await audit(principal,'create_payout','settlement_payout',payout.id,'provider_settlement',{ caseId:input.caseId });
    return payout;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function updatePayoutState(principal: Principal, payoutId:string, nextState:'approved'|'processing'|'paid'|'failed'|'cancelled', externalReference?:string) {
  const client=await pool.connect();
  try{
    await client.query('begin');
    const current = await client.query('select * from settlement_payouts where id=$1 for update',[payoutId]);
    if (!current.rowCount) throw new Error('payout_not_found');
    const p = current.rows[0];
    if(p.state===nextState){
      await client.query('commit');
      return p;
    }
    const allowed:Record<string,string[]> = { pending:['approved','cancelled'], approved:['processing','paid','cancelled'], processing:['paid','failed'], paid:[], failed:['processing','cancelled'], cancelled:[] };
    if (!allowed[p.state]?.includes(nextState)) throw new Error('invalid_payout_transition');
    const paidSql = nextState === 'paid' ? ',paid_at=now()' : '';
    const r = await client.query(`update settlement_payouts set state=$1,updated_at=now() ${paidSql} where id=$2 returning *`,[nextState,payoutId]);
    if (nextState === 'paid') {
      await client.query(`insert into ledger_entries(case_id,payment_intent_id,payout_id,entry_type,account_code,counterparty_actor_id,amount,currency,state,external_reference,metadata) values($1,$2,$3,'provider_payout','provider_payable',$4,$5,$6,'posted',$7,$8)`,[p.case_id,p.payment_intent_id ?? null,payoutId,p.counterparty_actor_id,-Math.abs(Number(p.amount)),p.currency,externalReference ?? p.provider_payout_id ?? null,JSON.stringify({ provider:p.provider })]);
    }
    await appendCaseEvent(p.case_id,`PAYOUT_${nextState.toUpperCase()}`,principal,{ payoutId, counterpartyActorId:p.counterparty_actor_id, amount:p.amount },client);
    await client.query('commit');
    await audit(principal,'payout_state_change','settlement_payout',payoutId,`${p.state}->${nextState}`);
    return r.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
