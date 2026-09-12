import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { humanizeToken } from '../lib/format';

type Reconciliation = {
  generatedAt:string;
  scanned:{payments:number;payouts:number};
  summary:{total:number;critical:number;warning:number};
  discrepancies:Array<{
    kind:string;
    severity:'warning'|'critical';
    caseId:string;
    paymentIntentId:string|null;
    payoutId:string|null;
    provider:string|null;
    providerReference:string|null;
    message:string;
    observed:Record<string,unknown>;
  }>;
};

function errorMessage(error:unknown){
  if(error instanceof ApiError)return humanizeToken(error.message);
  return 'Financial reconciliation could not be loaded.';
}

export function FinancialOperations(){
  const [data,setData]=useState<Reconciliation|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);

  const load=useCallback(async()=>{
    setLoading(true);setError(null);
    try{setData(await api.get<Reconciliation>('/api/admin/financial-reconciliation?limit=500'));}
    catch(e){setError(errorMessage(e));setData(null);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{void load();},[load]);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">Financial truth</p><h1 className="text-xl font-semibold">Reconciliation</h1><p className="mt-1 text-sm text-slate-600">Detect state, provider-reference, event, ledger, and payout inconsistencies before they become settlement errors.</p></div>
      <button type="button" className="roviq-btn-secondary text-sm" disabled={loading} onClick={()=>void load()}>{loading?'Checking…':'Run check'}</button>
    </div>

    {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}

    <div className="grid gap-3 sm:grid-cols-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Discrepancies</p><p className="mt-1 text-2xl font-semibold">{data?.summary.total??'—'}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Critical</p><p className="mt-1 text-2xl font-semibold">{data?.summary.critical??'—'}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Payments scanned</p><p className="mt-1 text-2xl font-semibold">{data?.scanned.payments??'—'}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Payouts scanned</p><p className="mt-1 text-2xl font-semibold">{data?.scanned.payouts??'—'}</p></div>
    </div>

    {loading&&!data&&<p className="text-sm text-slate-500">Reconciling financial records…</p>}
    {data&&data.discrepancies.length===0&&<div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800"><strong>No internal financial discrepancies found.</strong><p className="mt-1">This verifies ROVIQ database consistency only; live provider settlement still requires provider-side reconciliation.</p></div>}

    {data&&data.discrepancies.length>0&&<ul className="space-y-3">{data.discrepancies.map((item,index)=><li key={`${item.kind}-${item.caseId}-${item.paymentIntentId??item.payoutId??index}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><Link to={`/cases/${item.caseId}`} className="font-medium text-slate-900 hover:underline">{item.message}</Link><p className="mt-1 text-xs text-slate-500">{humanizeToken(item.kind)} · Provider: {item.provider??'unknown'}{item.providerReference?` · Ref ${item.providerReference}`:''}</p></div><span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${item.severity==='critical'?'bg-red-100 text-red-800':'bg-amber-100 text-amber-800'}`}>{item.severity}</span></div>
      <details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer font-medium">Observed values</summary><pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3">{JSON.stringify(item.observed,null,2)}</pre></details>
    </li>)}</ul>}
  </div>;
}
