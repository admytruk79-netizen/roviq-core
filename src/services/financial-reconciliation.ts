import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

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

export async function getFinancialReconciliation(principal:Principal,limit=200){
  if(principal.role!=='admin')throw forbidden('financial_admin_only');
  if(principal.actorId)throw forbidden('financial_global_admin_only');
  const bounded=Math.max(1,Math.min(500,limit));

  const [payments,payouts,paymentCount,payoutCount]=await Promise.all([
    pool.query(`
      select p.id,p.case_id,p.provider,p.provider_intent_id,p.amount,p.currency,p.state,
        coalesce((select sum(pe.amount) from payment_events pe where pe.payment_intent_id=p.id and pe.event_type='REFUND'),0)::numeric as refunded_amount,
        coalesce((select count(*) from payment_events pe where pe.payment_intent_id=p.id and pe.event_type='CAPTURED'),0)::int as capture_events,
        coalesce((select sum(le.amount) from ledger_entries le where le.payment_intent_id=p.id and le.entry_type='payment_capture'),0)::numeric as capture_ledger_amount,
        coalesce((select sum(le.amount) from ledger_entries le where le.payment_intent_id=p.id and le.entry_type='refund'),0)::numeric as refund_ledger_amount
      from payment_intents p
      order by p.updated_at desc,p.id desc
      limit $1`,[bounded]),
    pool.query(`
      select s.id,s.case_id,s.payment_intent_id,s.provider,s.provider_payout_id,s.amount,s.currency,s.state,
        p.state as payment_state,p.amount as payment_amount,p.currency as payment_currency,
        coalesce((select sum(le.amount) from ledger_entries le where le.payout_id=s.id and le.entry_type='provider_payout'),0)::numeric as payout_ledger_amount
      from settlement_payouts s
      left join payment_intents p on p.id=s.payment_intent_id
      order by s.updated_at desc,s.id desc
      limit $1`,[bounded]),
    pool.query(`select count(*)::int as total from payment_intents`),
    pool.query(`select count(*)::int as total from settlement_payouts`)
  ]);

  const discrepancies:FinancialDiscrepancy[]=[];
  for(const row of payments.rows){
    const amount=Number(row.amount);
    const refunded=Number(row.refunded_amount);
    const capturedLedger=Number(row.capture_ledger_amount);
    const refundLedger=Number(row.refund_ledger_amount);
    const capturedStates=['captured','partially_refunded','refunded'];
    if(row.provider!=='manual'&&!row.provider_intent_id){
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
    if(row.payment_intent_id&&row.payment_state&&['created','requires_action','authorized','cancelled','failed'].includes(row.payment_state)){
      discrepancies.push({kind:'payout_linked_to_uncaptured_payment',severity:'critical',caseId:row.case_id,paymentIntentId:row.payment_intent_id,payoutId:row.id,provider:row.provider,providerReference:row.provider_payout_id,message:'Payout is linked to a payment that has not been captured.',observed:{payoutState:row.state,paymentState:row.payment_state}});
    }
  }

  const totalPayments=Number(paymentCount.rows[0]?.total??0);
  const totalPayouts=Number(payoutCount.rows[0]?.total??0);
  const scannedPayments=payments.rowCount??0;
  const scannedPayouts=payouts.rowCount??0;
  const complete=scannedPayments>=totalPayments&&scannedPayouts>=totalPayouts;

  return {
    generatedAt:new Date().toISOString(),
    complete,
    truncated:!complete,
    limit:bounded,
    scanned:{payments:scannedPayments,payouts:scannedPayouts},
    totals:{payments:totalPayments,payouts:totalPayouts},
    summary:{total:discrepancies.length,critical:discrepancies.filter(item=>item.severity==='critical').length,warning:discrepancies.filter(item=>item.severity==='warning').length},
    discrepancies
  };
}
