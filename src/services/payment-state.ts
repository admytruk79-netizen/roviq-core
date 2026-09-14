import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent, finalizeExternalCaseTransition, transitionCase } from './orchestration.js';
import { audit } from './audit.js';
import { setCustomerSnapshot } from './operations.js';

const ZERO_DECIMAL_CURRENCIES=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);

function amountEquals(a:unknown,b:unknown){return Number(a)===Number(b);}
function normalizeProvider(provider:unknown){const normalized=String(provider??'manual').trim().toLowerCase();return normalized||'manual';}
function assertFinancialAmount(amount:number,currency:string){
  if(!Number.isFinite(amount)||amount<0) throw new Error('invalid_financial_amount');
  const factor=ZERO_DECIMAL_CURRENCIES.has(currency)?1:100;
  const rounded=Math.round(amount*factor)/factor;
  if(!Number.isSafeInteger(Math.round(amount*factor))||rounded!==amount) throw new Error('invalid_financial_amount');
}

async function assertFinancialCaseAccess(principal:Principal,caseId:string,client:Pick<PoolClient,'query'>){
  if(principal.role!=='admin') throw new Error('forbidden');
  if(!principal.actorId)return;
  const actor=await client.query(`select organization_id from actors where id=$1 and status='active'`,[principal.actorId]);
  if(!actor.rowCount) throw new Error('forbidden');
  const organizationId=actor.rows[0].organization_id;
  const scoped=await client.query(`
    select exists(
      select 1 from service_cases sc
      left join actors owner on owner.id=sc.current_owner_actor_id
      left join actors selected on selected.id=sc.selected_actor_id
      where sc.id=$1 and (
        owner.organization_id=$2 or selected.organization_id=$2 or
        exists(select 1 from matches_offers mo join actors a on a.id=mo.actor_id where mo.case_id=sc.id and mo.outcome='accepted' and a.organization_id=$2) or
        exists(select 1 from transport_dispatches td join actors a on a.id=td.provider_actor_id where td.case_id=sc.id and a.organization_id=$2) or
        exists(select 1 from parts_orders po join actors a on a.id=po.supplier_actor_id where po.case_id=sc.id and a.organization_id=$2) or
        exists(select 1 from mobility_allocations ma join actors a on a.id=ma.provider_actor_id where ma.case_id=sc.id and a.organization_id=$2)
      )
    ) as allowed`,[caseId,organizationId]);
  if(!scoped.rows[0]?.allowed) throw new Error('forbidden');
}

export async function updatePaymentState(principal:Principal,paymentIntentId:string,nextState:'requires_action'|'authorized'|'captured'|'cancelled'|'failed',input:{amount?:number;providerEventId?:string;payload?:Record<string,unknown>}={}){
  const preview=await pool.query('select case_id from payment_intents where id=$1',[paymentIntentId]);
  if(!preview.rowCount) throw new Error('payment_not_found');
  const client=await pool.connect();
  let transitioned=false;
  let committed=false;
  let capturedCaseId:string|null=null;
  try{
    await client.query('begin');
    const caseLock=await client.query('select id,state from service_cases where id=$1 for update',[preview.rows[0].case_id]);
    if(!caseLock.rowCount) throw new Error('case_not_found');
    await assertFinancialCaseAccess(principal,preview.rows[0].case_id,client);
    const current=await client.query('select * from payment_intents where id=$1 for update',[paymentIntentId]);
    if(!current.rowCount) throw new Error('payment_not_found');
    const p=current.rows[0];
    const eventProvider=normalizeProvider(p.provider);
    if(input.amount!==undefined) assertFinancialAmount(input.amount,String(p.currency).toUpperCase());

    if(input.providerEventId){
      const prior=await client.query(`select payment_intent_id,event_type,amount from payment_events where provider=$1 and provider_event_id=$2`,[eventProvider,input.providerEventId]);
      if(prior.rowCount){
        const event=prior.rows[0];
        if(event.payment_intent_id!==paymentIntentId||event.event_type!==nextState.toUpperCase()||(input.amount!==undefined&&event.amount!==null&&!amountEquals(event.amount,input.amount))) throw new Error('provider_event_conflict');
        await client.query('commit');
        committed=true;
        return p;
      }
    }

    if(nextState==='captured'&&input.amount!==undefined&&!amountEquals(input.amount,p.amount)) throw new Error('capture_amount_mismatch');

    if(p.state===nextState){
      if(input.providerEventId){
        const canonicalAmount=nextState==='captured'?Number(p.amount):(input.amount??null);
        await client.query(`insert into payment_events(payment_intent_id,event_type,amount,provider,provider_event_id,payload) values($1,$2,$3,$4,$5,$6)`,[
          paymentIntentId,nextState.toUpperCase(),canonicalAmount,eventProvider,input.providerEventId,JSON.stringify(input.payload??{})
        ]);
      }
      await client.query('commit');
      committed=true;
      return p;
    }

    const allowed:Record<string,string[]>={created:['requires_action','authorized','captured','cancelled','failed'],requires_action:['authorized','captured','cancelled','failed'],authorized:['captured','cancelled','failed'],captured:[],cancelled:[],failed:[],partially_refunded:[],refunded:[]};
    if(!allowed[p.state]?.includes(nextState)) throw new Error('invalid_payment_transition');
    const canonicalAmount=nextState==='captured'?Number(p.amount):(input.amount??null);
    const stamp=nextState==='authorized'?',authorized_at=now()':nextState==='captured'?',captured_at=now()':nextState==='cancelled'?',cancelled_at=now()':'';
    const updated=await client.query(`update payment_intents set state=$1,updated_at=now() ${stamp} where id=$2 returning *`,[nextState,paymentIntentId]);
    await client.query(`insert into payment_events(payment_intent_id,event_type,amount,provider,provider_event_id,payload) values($1,$2,$3,$4,$5,$6)`,[
      paymentIntentId,nextState.toUpperCase(),canonicalAmount,eventProvider,input.providerEventId??null,JSON.stringify(input.payload??{})
    ]);
    if(nextState==='captured'){
      await client.query(`insert into ledger_entries(case_id,payment_intent_id,entry_type,account_code,amount,currency,state,external_reference,metadata) values($1,$2,'payment_capture','customer_receivable',$3,$4,'posted',$5,$6)`,[
        p.case_id,paymentIntentId,p.amount,p.currency,input.providerEventId??null,JSON.stringify({provider:eventProvider})
      ]);
      capturedCaseId=p.case_id;
    }
    await appendCaseEvent(p.case_id,`PAYMENT_${nextState.toUpperCase()}`,principal,{paymentIntentId,amount:canonicalAmount??p.amount},client);
    if(nextState==='captured'&&caseLock.rows[0].state==='payment_pending'){
      await transitionCase(principal,p.case_id,'completed',{paymentIntentId},client);
      transitioned=true;
    }
    await client.query('commit');
    committed=true;

    if(nextState==='captured'&&capturedCaseId){
      const sideEffects:Promise<unknown>[]=[
        setCustomerSnapshot(capturedCaseId,'payment_received','Payment received. Finalizing your service journey.','Completion')
      ];
      if(transitioned) sideEffects.push(finalizeExternalCaseTransition(principal,capturedCaseId,'payment_pending','completed',{paymentIntentId}));
      const results=await Promise.allSettled(sideEffects);
      results.forEach((result,index)=>{
        if(result.status==='rejected') console.error(index===0?'payment_post_commit_projection_failed':'payment_post_commit_transition_finalize_failed',{
          paymentIntentId,caseId:capturedCaseId,message:result.reason instanceof Error?result.reason.message:String(result.reason)
        });
      });
    }
    await audit(principal,'payment_state_change','payment_intent',paymentIntentId,`${p.state}->${nextState}`);
    return updated.rows[0];
  }catch(error){
    if(!committed) await client.query('rollback');
    throw error;
  }finally{client.release();}
}
