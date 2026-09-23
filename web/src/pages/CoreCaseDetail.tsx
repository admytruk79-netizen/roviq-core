import { useEffect,useState } from 'react';
import { Link,useParams } from 'react-router-dom';
import { api,ApiError } from '../lib/api';
import { formatDateTime,humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';

type CoreCase={id:string;case_type:string;state:string;priority:string;version:number;updated_at:string};
type Event={id:string;event_type:string;occurred_at:string;new_version:number;payload:Record<string,unknown>};
type Approval={id:string;approval_type:string;action:string;state:string;created_at:string;decided_at:string|null;reason?:string|null};
type Saga={id:string;saga_type:string;state:string;current_step:string|null;updated_at:string;last_error:string|null};
type Trade={trade:{phase:string;trade_mode:string;origin_country:string;destination_country:string};milestones:Array<{id:string;milestone_code:string;state:string}>;documents:Array<{id:string;document_type:string;status:string;external_reference:string|null}>};

function errText(e:unknown){if(e instanceof ApiError){const b=e.body as {error?:string}|null;return b?.error??e.message}return e instanceof Error?e.message:'Operation failed'}

export function CoreCaseDetail(){
  const{id}=useParams();
  const[data,setData]=useState<{case:CoreCase;events:Event[]}|null>(null);
  const[approvals,setApprovals]=useState<Approval[]>([]);
  const[sagas,setSagas]=useState<Saga[]>([]);
  const[trade,setTrade]=useState<Trade|null>(null);
  const[error,setError]=useState<string|null>(null);
  const[busy,setBusy]=useState<string|null>(null);
  const[refresh,setRefresh]=useState(0);
  useEffect(()=>{if(!id)return;let live=true;(async()=>{try{setError(null);const[c,a,s]=await Promise.all([api.get<{case:CoreCase;events:Event[]}>(`/api/core/cases/${id}`),api.get<{approvals:Approval[]}>(`/api/core/cases/${id}/approvals`),api.get<{sagas:Saga[]}>(`/api/core/cases/${id}/sagas`)]);if(!live)return;setData(c);setApprovals(a.approvals);setSagas(s.sagas);if(c.case.case_type==='trade'){setTrade(await api.get<Trade>(`/api/core/trade-cases/${id}`))}else setTrade(null)}catch(e){if(live)setError(errText(e))}})();return()=>{live=false}},[id,refresh]);
  async function decide(approvalId:string,decision:'approved'|'rejected'){if(!id)return;setBusy(approvalId);try{await api.post(`/api/core/cases/${id}/approvals/${approvalId}/decision`,{decision});setRefresh(v=>v+1)}catch(e){setError(errText(e))}finally{setBusy(null)}}
  if(error&&!data)return <div className="roviq-error">{error}</div>;
  if(!data)return <div className="roviq-panel p-5 roviq-muted">Loading coordinated case…</div>;
  const c=data.case;
  return <div className="space-y-5">
    <section className="roviq-customer-hero"><div><p className="roviq-kicker">{humanizeToken(c.case_type)} · coordinated case</p><h1>Case {c.id.slice(0,8)}</h1><p className="roviq-muted">Current ROVIQ Core state and decisions that need your attention.</p></div><StatusBadge state={c.state}/></section>
    {error&&<div className="roviq-error">{error}</div>}
    <section className="roviq-summary-strip"><div><span>State</span><strong>{humanizeToken(c.state)}</strong></div><div><span>Priority</span><strong>{humanizeToken(c.priority)}</strong></div><div><span>Version</span><strong>{c.version}</strong></div></section>
    {trade&&<section className="roviq-panel p-5"><p className="roviq-kicker">Trade progress</p><h2 className="mt-1 text-xl font-bold">{humanizeToken(trade.trade.trade_mode)} · {trade.trade.origin_country} → {trade.trade.destination_country}</h2><div className="mt-3"><StatusBadge state={trade.trade.phase}/></div><div className="mt-5 grid gap-2 sm:grid-cols-2">{trade.milestones.map(m=><div key={m.id} className="rounded-xl border border-slate-200 p-3"><p className="text-sm font-semibold">{humanizeToken(m.milestone_code)}</p><div className="mt-2"><StatusBadge state={m.state}/></div></div>)}</div></section>}
    <section className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><p className="roviq-kicker">Your decisions</p><h2 className="text-lg font-bold">Approvals</h2></div><div className="divide-y divide-slate-200">{approvals.length===0&&<p className="p-4 roviq-muted">No approval requests.</p>}{approvals.map(a=><div key={a.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><strong>{humanizeToken(a.approval_type)}</strong><p className="roviq-muted mt-1 text-sm">{humanizeToken(a.action)} · requested {formatDateTime(a.created_at)}</p></div><StatusBadge state={a.state}/></div>{a.state==='pending'&&<div className="mt-3 flex gap-2"><button className="roviq-btn-primary" disabled={busy!==null} onClick={()=>void decide(a.id,'approved')}>{busy===a.id?'Saving…':'Approve'}</button><button className="roviq-btn-secondary" disabled={busy!==null} onClick={()=>void decide(a.id,'rejected')}>Reject</button></div>}</div>)}</div></section>
    <section className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><p className="roviq-kicker">Progress</p><h2 className="text-lg font-bold">Workflow status</h2></div><div className="divide-y divide-slate-200">{sagas.length===0&&<p className="p-4 roviq-muted">No active workflow record.</p>}{sagas.map(s=><div key={s.id} className="p-4"><div className="flex justify-between gap-3"><strong>{humanizeToken(s.saga_type)}</strong><StatusBadge state={s.state}/></div><p className="roviq-muted mt-1 text-sm">{s.current_step?humanizeToken(s.current_step):'Waiting for next action'} · updated {formatDateTime(s.updated_at)}</p></div>)}</div></section>
    <section className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><p className="roviq-kicker">History</p><h2 className="text-lg font-bold">Case timeline</h2></div><div className="divide-y divide-slate-200">{data.events.map(e=><div key={e.id} className="p-4"><div className="flex justify-between gap-3"><strong>{humanizeToken(e.event_type)}</strong><span className="roviq-muted text-xs">{formatDateTime(e.occurred_at)}</span></div></div>)}</div></section>
    <Link to="/core-cases" className="roviq-btn-secondary inline-flex">Back to coordinated cases</Link>
  </div>
}
