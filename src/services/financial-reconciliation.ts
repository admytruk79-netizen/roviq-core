import { isRetryableConnectionError, pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

const ZERO_DECIMAL_CURRENCIES=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);

export type FinancialDiscrepancy = {
  kind:string;
  severity:'warning'|'critical';
  caseId:string;
  paymentIntentId:string|null;
  payoutId:string|null;
  provider:string|null;
  providerReference:string|null;
  message:string;
  observed:Record<string,unknown>;
};

function forbidden(message:string){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=403;
  return error;
}

async function reconcileSnapshot(bounded:number){
  const client=await pool.connect();
  let transactionStarted=false;
  try{
    await client.query('begin isolation level repeatable read read only');
    transactionStarted=true;
    const payments=await client.query(`
      select p.id,p.case_id,p.provider,p.provider_intent_id,p.amount,p.currency,p.state,
        coalesce((select sum(pe.amount) from payment_events pe where pe.payment_intent_id=p.id and pe.event_type='REFUND'),0)::numeric as refunded_amount,
        coalesce((select count(*) from payment_events pe where pe.payment_intent_id=p.id and pe.event_type='CAPTURED'),0)::int as capture_events,
        coalesce((select sum(le.amount) from ledger_entries le where le.payment_intent_id=p.id and le.entry_type='payment_capture'),0)::numeric as capture_ledger_amount,
        coalesce((select sum(le.amount) from ledger_entries le where le.payment_intent_id=p.id and le.entry_type='refund'),0)::numeric as refund_ledger_amount
      from payment_intents p
      order by p.updated_at desc,p.id desc
      limit $1`,[bounded]);
    const payouts=await client.query(`
      select s.id,s.case_id,s.payment_intent_id,s.provider,s.provider_payout_id,s.amount,s.currency,s.state,
        p.state as payment_state,p.amount as payment_amount,p.currency as payment_currency,
        coalesce((select sum(le.amount) from ledger_entries le where le.payout_id=s.id and le.entry_type='provider_payout'),0)::numeric as payout_ledger_amount
      from settlement_payouts s
      left join payment_intents p on p.id=s.payment_intent_id
      order by s.updated_at desc,s.id desc
      limit $1`,[bounded]);
    const disputes=await client.query(`
      select d.id,d.payment_intent_id,d.provider,d.external_reference,d.amount_minor,d.currency,d.status,d.reason,d.evidence_due_at,
        p.case_id,
        coalesce((select sum(le.amount) from ledger_entries le
          where le.payment_intent_id=d.payment_intent_id
            and le.entry_type='payment_dispute_loss'
            and le.external_reference=d.external_reference),0)::numeric as dispute_ledger_amount
      from payment_disputes d
      join payment_intents p on p.id=d.payment_intent_id
      order by d.opened_at desc,d.id desc
      limit $1`,[bounded]);
    const paymentCount=await client.query(`select count(*)::int as total from payment_intents`);
    const payoutCount=await client.query(`select count(*)::int as total from settlement_payouts`);
    const disputeCount=await client.query(`select count(*)::int as total from payment_disputes`);

    const discrepancies:FinancialDiscrepancy[]=[];
    for(const row of payments.rows){
      const amount=Number(row.amount);
      const refunded=Number(row.refunded_amount);
      const capturedLedger=Number(row.capture_ledger_amount);
      const refundLedger=Number(row.refund_ledger_amount);
      const capturedStates=['captured','partially_refunded','refunded'];
      if(row.provider!=='manual'&&!row.provider_intent_id&&!['failed','cancelled'].includes(row.state)){
        discrepancies.push({kind:'payment_provider_reference_missing',severity:'critical',caseId:row.case_id,paymentIntentId:row.id,payoutId:null,provider:row.provider,providerReference:null,message:'Provider-backed payment has no provider intent reference.',observed:{state:row.state,amount,currency:row.currency}});
      }
      if(capturedStates.includes(row.state)&&Number(row.capture_events)===0){
        discrepancies.push({kind:'payment_capture_event_missing',severity:'critical',caseId:row.case_id,paymentIntentId:row.id,payoutId:null,provider:row.provider,providerReference:row.provider_intent_id,message:'Captured payment state has no capture event.',observed:{state:row.state,amount,currency:row.currency}});
      }
      if(capturedStates.includes(row.state)&&capturedLedger!==amount){
        discrepancies.push({kind:'payment_capture_ledger_mismatch',severity:'critical',caseId:row.case_id,paymentIntentId:row.id,payoutId:null,provider:row.provider,providerReference:row.provider_intent_id,message:'Captured payment amount does not match posted capture ledger amount.',observed:{paymentAmount:amount,captureLedgerAmount:capturedLedger,state:row.state,currency:row.currency}});
      }
      if(Math.abs(refundLedger)!==refunded){
        discrepancies.push({kind:'payment_refund_ledger_mismatch',severity:'critical',caseId:row.case_id,paymentIntentId:row.id,payoutId:null,provider:row.provider,providerReference:row.provider_intent_id,message:'Refund events do not match refund ledger postings.',observed:{refundEventsAmount:refunded,refundLedgerAmount:refundLedger,state:row.state,currency:row.currency}});
      }
      if(row.state==='refunded'&&refunded!==amount){
        discrepancies.push({kind:'payment_refund_state_mismatch',severity:'critical',caseId:row.case_id,paymentIntentId:row.id,payoutId:null,provider:row.provider,providerReference:row.provider_intent_id,message:'Payment is marked refunded but total refund events do not equal the captured amount.',observed:{paymentAmount:amount,refundedAmount:refunded,currency:row.currency}});
      }
      if(row.state==='partially_refunded'&&(refunded<=0||refunded>=amount)){
        discrepancies.push({kind:'payment_partial_refund_state_mismatch',severity:'warning',caseId:row.case_id,paymentIntentId:row.id,payoutId:null,provider:row.provider,providerReference:row.provider_intent_id,message:'Partial-refund state is inconsistent with refund event totals.',observed:{paymentAmount:amount,refundedAmount:refunded,currency:row.currency}});
      }
    }

    for(const row of payouts.rows){
      const amount=Number(row.amount);
      const ledger=Number(row.payout_ledger_amount);
      if(row.provider!=='manual'&&!row.provider_payout_id){
        discrepancies.push({kind:'payout_provider_reference_missing',severity:'critical',caseId:row.case_id,paymentIntentId:row.payment_intent_id,payoutId:row.id,provider:row.provider,providerReference:null,message:'Provider-backed payout has no provider payout reference.',observed:{state:row.state,amount,currency:row.currency}});
      }
      if(row.payment_intent_id&&row.payment_currency&&row.payment_currency!==row.currency){
        discrepancies.push({kind:'payout_currency_mismatch',severity:'critical',caseId:row.case_id,paymentIntentId:row.payment_intent_id,payoutId:row.id,provider:row.provider,providerReference:row.provider_payout_id,message:'Payout currency does not match its linked payment.',observed:{payoutCurrency:row.currency,paymentCurrency:row.payment_currency}});
      }
      if(row.state==='paid'&&ledger!==-Math.abs(amount)){
        discrepancies.push({kind:'payout_ledger_mismatch',severity:'critical',caseId:row.case_id,paymentIntentId:row.payment_intent_id,payoutId:row.id,provider:row.provider,providerReference:row.provider_payout_id,message:'Paid payout does not match its posted provider-payable ledger amount.',observed:{payoutAmount:amount,payoutLedgerAmount:ledger,currency:row.currency}});
      }
      if(row.state!=='paid'&&ledger!==0){
        discrepancies.push({kind:'premature_payout_ledger_entry',severity:'critical',caseId:row.case_id,paymentIntentId:row.payment_intent_id,payoutId:row.id,provider:row.provider,providerReference:row.provider_payout_id,message:'A provider payout ledger entry exists before the payout is paid.',observed:{state:row.state,payoutLedgerAmount:ledger,currency:row.currency}});
      }
      if(row.payment_intent_id&&row.payment_state&&['created','requires_action','authorized','cancelled','failed','refunded'].includes(row.payment_state)){
        discrepancies.push({kind:'payout_linked_to_uncaptured_payment',severity:'critical',caseId:row.case_id,paymentIntentId:row.payment_intent_id,payoutId:row.id,provider:row.provider,providerReference:row.provider_payout_id,message:'Payout is linked to a payment with no remaining captured funding.',observed:{payoutState:row.state,paymentState:row.payment_state}});
      }
    }


    for(const row of disputes.rows){
      const factor=ZERO_DECIMAL_CURRENCIES.has(String(row.currency).toUpperCase())?1:100;
      const amount=Number(row.amount_minor)/factor;
      const ledger=Number(row.dispute_ledger_amount);
      if(['needs_response','under_review'].includes(row.status)){
        discrepancies.push({
          kind:'payment_dispute_open',
          severity:'warning',
          caseId:row.case_id,
          paymentIntentId:row.payment_intent_id,
          payoutId:null,
          provider:row.provider,
          providerReference:row.external_reference,
          message:'Payment dispute is open and requires operational attention.',
          observed:{state:row.status,amount,currency:row.currency,reason:row.reason,evidenceDueAt:row.evidence_due_at}
        });
      }
      if(row.status==='lost'&&ledger!==-Math.abs(amount)){
        discrepancies.push({
          kind:'payment_dispute_loss_ledger_mismatch',
          severity:'critical',
          caseId:row.case_id,
          paymentIntentId:row.payment_intent_id,
          payoutId:null,
          provider:row.provider,
          providerReference:row.external_reference,
          message:'Lost payment dispute does not match its chargeback-loss ledger posting.',
          observed:{disputeAmount:amount,disputeLedgerAmount:ledger,currency:row.currency}
        });
      }
      if(row.status!=='lost'&&ledger!==0){
        discrepancies.push({
          kind:'premature_payment_dispute_loss_ledger',
          severity:'critical',
          caseId:row.case_id,
          paymentIntentId:row.payment_intent_id,
          payoutId:null,
          provider:row.provider,
          providerReference:row.external_reference,
          message:'A chargeback-loss ledger posting exists before the dispute is lost.',
          observed:{state:row.status,disputeLedgerAmount:ledger,currency:row.currency}
        });
      }
    }

    const totalPayments=Number(paymentCount.rows[0]?.total??0);
    const totalPayouts=Number(payoutCount.rows[0]?.total??0);
    const totalDisputes=Number(disputeCount.rows[0]?.total??0);
    const scannedPayments=payments.rowCount??0;
    const scannedPayouts=payouts.rowCount??0;
    const scannedDisputes=disputes.rowCount??0;
    const complete=scannedPayments>=totalPayments&&scannedPayouts>=totalPayouts&&scannedDisputes>=totalDisputes;
    const result={
      generatedAt:new Date().toISOString(),
      complete,
      truncated:!complete,
      limit:bounded,
      scanned:{payments:scannedPayments,payouts:scannedPayouts,disputes:scannedDisputes},
      totals:{payments:totalPayments,payouts:totalPayouts,disputes:totalDisputes},
      summary:{total:discrepancies.length,critical:discrepancies.filter(item=>item.severity==='critical').length,warning:discrepancies.filter(item=>item.severity==='warning').length},
      discrepancies
    };
    await client.query('commit');
    transactionStarted=false;
    return result;
  }catch(error){
    if(transactionStarted){
      try{await client.query('rollback');}catch(rollbackError){
        console.warn('financial_reconciliation_rollback_failed',{message:rollbackError instanceof Error?rollbackError.message:String(rollbackError)});
      }
    }
    throw error;
  }finally{
    client.release();
  }
}

export async function getFinancialReconciliation(principal:Principal,limit=200){
  if(principal.role!=='admin')throw forbidden('financial_admin_only');
  if(principal.actorId)throw forbidden('financial_global_admin_only');
  const bounded=Math.max(1,Math.min(500,limit));
  try{
    return await reconcileSnapshot(bounded);
  }catch(error){
    if(!isRetryableConnectionError(error)) throw error;
    console.warn('financial_reconciliation_transient_retry',{message:error instanceof Error?error.message:String(error)});
    return await reconcileSnapshot(bounded);
  }
}
