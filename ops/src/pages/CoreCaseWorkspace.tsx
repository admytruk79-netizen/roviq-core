import { useEffect,useMemo,useState } from 'react';
import { Link,useParams } from 'react-router-dom';
import { api,ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';

type CoreCase=Record<string,unknown>&{id:string;case_type:string;state:string;priority:string;version:number;updated_at:string};
type Event={id:string;event_type:string;actor_id:string|null;occurred_at:string;payload:Record<string,unknown>;new_version:number};
type Approval={id:string;approval_type:string;action:string;state:string;created_at:string;decided_at:string|null;requested_from_actor_id:string|null;reason?:string|null};
type Saga={id:string;saga_type:string;state:string;current_step:string|null;updated_at:string;last_error:string|null};
type Action={to:string;action:string;approvalRecommended:boolean};
type Actions={caseId:string;state:string;version:number;terminal:boolean;transitions:Action[]};
type TradeMilestone={id:string;milestone_code:string;state:string;evidence:Record<string,unknown>};
type TradeDocument={id:string;document_type:string;status:string;external_reference:string|null;created_at:string};
type TradeData={trade:{phase:string;trade_mode:string;origin_country:string;destination_country:string;origin_location:string|null;destination_location:string|null;subject:Record<string,unknown>};milestones:TradeMilestone[];documents:TradeDocument[]};
type TradeActions={caseId:string;phase:string;version:number;transitions:Action[]};

function pretty(value:string){return value.replaceAll('_',' ').replace(/\b\w/g,m=>m.toUpperCase());}
function errorText(error:unknown){
  if(error instanceof ApiError){
    const body=error.body as {error?:string;reason?:string}|null;
    return body?.reason??body?.error??error.message;
  }
  return error instanceof Error?error.message:'Operation failed';
}

export function CoreCaseWorkspace(){
  const {id}=useParams();
  const [data,setData]=useState<{case:CoreCase;events:Event[]}|null>(null);
  const [approvals,setApprovals]=useState<Approval[]>([]);
  const [sagas,setSagas]=useState<Saga[]>([]);
  const [actions,setActions]=useState<Actions|null>(null);
  const [trade,setTrade]=useState<TradeData|null>(null);
  const [tradeActions,setTradeActions]=useState<TradeActions|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  const [docType,setDocType]=useState('');
  const [docRef,setDocRef]=useState('');

  useEffect(()=>{
    if(!id)return;
    let live=true;
    async function load(){
      setError(null);
      try{
        const [c,a,s,acts]=await Promise.all([
          api.get<{case:CoreCase;events:Event[]}>(`/api/core/cases/${id}`),
          api.get<{approvals:Approval[]}>(`/api/core/cases/${id}/approvals`),
          api.get<{sagas:Saga[]}>(`/api/core/cases/${id}/sagas`),
          api.get<Actions>(`/api/core/cases/${id}/actions`)
        ]);
        if(!live)return;
        setData(c);setApprovals(a.approvals);setSagas(s.sagas);setActions(acts);
        if(c.case.case_type==='trade'){
          const [t,ta]=await Promise.all([
            api.get<TradeData>(`/api/core/trade-cases/${id}`),
            api.get<TradeActions>(`/api/core/trade-cases/${id}/phase-actions`)
          ]);
          if(live){setTrade(t);setTradeActions(ta);}
        }else if(live){setTrade(null);setTradeActions(null);}
      }catch(e){if(live)setError(errorText(e));}
    }
    void load();
    return()=>{live=false};
  },[id,refresh]);

  const approvedByAction=useMemo(()=>{
    const map=new Map<string,Approval>();
    for(const a of approvals)if(a.state==='approved')map.set(a.action,a);
    return map;
  },[approvals]);

  async function decide(approvalId:string,decision:'approved'|'rejected'){
    if(!id)return;setBusy(`approval:${approvalId}`);setNotice(null);setError(null);
    try{
      await api.post(`/api/core/cases/${id}/approvals/${approvalId}/decision`,{decision});
      setNotice(`Approval ${decision}.`);setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}finally{setBusy(null);}
  }

  async function transition(action:Action){
    if(!id||!actions)return;
    setBusy(`transition:${action.to}`);setNotice(null);setError(null);
    const approval=approvedByAction.get(action.action);
    try{
      await api.postWithHeaders(`/api/core/cases/${id}/transition`,{
        expectedVersion:actions.version,
        requestedTransition:action.to,
        approvalId:approval?.id,
        evidence:{source:'ops_case_workspace'}
      },{'idempotency-key':crypto.randomUUID()});
      setNotice(`Case moved to ${pretty(action.to)}.`);setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}finally{setBusy(null);}
  }

  async function moveTrade(action:Action){
    if(!id||!tradeActions)return;
    setBusy(`trade:${action.to}`);setNotice(null);setError(null);
    const approval=approvedByAction.get(action.action);
    try{
      await api.post(`/api/core/trade-cases/${id}/phase`,{
        to:action.to,expectedVersion:tradeActions.version,approvalId:approval?.id,
        evidence:{source:'ops_trade_workspace'}
      });
      setNotice(`Trade phase moved to ${pretty(action.to)}.`);setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}finally{setBusy(null);}
  }

  async function milestone(code:string,state:'completed'|'waived'){
    if(!id)return;setBusy(`milestone:${code}`);setNotice(null);setError(null);
    try{
      await api.post(`/api/core/trade-cases/${id}/milestones/${code}`,{state,evidence:{source:'ops_trade_workspace'}});
      setNotice(`${pretty(code)} marked ${state}.`);setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}finally{setBusy(null);}
  }

  async function addDocument(){
    if(!id||!docType.trim())return;setBusy('document');setNotice(null);setError(null);
    try{
      await api.post(`/api/core/trade-cases/${id}/documents`,{documentType:docType.trim(),externalReference:docRef.trim()||undefined,metadata:{source:'ops_trade_workspace'}});
      setDocType('');setDocRef('');setNotice('Trade document added.');setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}finally{setBusy(null);}
  }

  if(error&&!data)return <div className="ops-error">{error}</div>;
  if(!data)return <div className="roviq-panel p-5 roviq-muted">Loading Case Workspace…</div>;
  const c=data.case;
  return <div className="space-y-5">
    <section className="ops-hero">
      <div><p className="roviq-kicker">{c.case_type} · Case Workspace</p><h1>Case {c.id.slice(0,8)}</h1><p className="roviq-muted">Authoritative state, workflows, approvals, actions and immutable event history.</p></div>
      <div className="flex items-center gap-2"><StatusBadge state={c.state}/><span className="roviq-btn-secondary">v{c.version}</span><button className="roviq-btn-secondary" onClick={()=>setRefresh(v=>v+1)}>Refresh</button></div>
    </section>

    {error&&<div className="ops-error" role="alert">{error}</div>}
    {notice&&<div className="roviq-panel p-4 text-sm font-medium text-emerald-800" role="status">{notice}</div>}

    <section className="grid gap-4 md:grid-cols-4">
      <div className="roviq-panel p-4"><p className="roviq-kicker">State</p><p className="mt-2 font-semibold">{pretty(c.state)}</p></div>
      <div className="roviq-panel p-4"><p className="roviq-kicker">Priority</p><p className="mt-2 font-semibold">{pretty(c.priority)}</p></div>
      <div className="roviq-panel p-4"><p className="roviq-kicker">Approvals</p><p className="mt-2 font-semibold">{approvals.filter(a=>a.state==='pending').length} pending</p></div>
      <div className="roviq-panel p-4"><p className="roviq-kicker">Workflows</p><p className="mt-2 font-semibold">{sagas.filter(s=>!['completed','cancelled'].includes(s.state)).length} active</p></div>
    </section>

    <section className="roviq-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="roviq-kicker">Authoritative commands</p><h2 className="text-lg font-semibold">Available Case actions</h2><p className="roviq-muted text-sm">Every command is version checked, policy gated and written to the Core event history.</p></div>{actions?.terminal&&<StatusBadge state="terminal"/>}</div>
      <div className="mt-4 flex flex-wrap gap-2">
        {actions?.transitions.map(a=>{
          const approval=approvedByAction.get(a.action);
          return <button key={a.to} type="button" className="roviq-btn-secondary" disabled={busy!==null||Boolean(a.approvalRecommended&&!approval)} onClick={()=>void transition(a)}>
            {busy===`transition:${a.to}`?'Applying…':pretty(a.to)}{a.approvalRecommended&&!approval?' · approval required':''}
          </button>;
        })}
        {actions&&actions.transitions.length===0&&<span className="roviq-muted text-sm">No state transitions are available from this state.</span>}
      </div>
    </section>

    {trade&&tradeActions&&<section className="roviq-panel overflow-hidden">
      <div className="border-b border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-3"><div><p className="roviq-kicker">TradeCase</p><h2 className="text-lg font-semibold">{pretty(trade.trade.trade_mode)} · {trade.trade.origin_country} → {trade.trade.destination_country}</h2><p className="roviq-muted text-sm">Current phase: {pretty(trade.trade.phase)}</p></div><StatusBadge state={trade.trade.phase}/></div></div>
      <div className="grid gap-5 p-4 lg:grid-cols-2">
        <div>
          <h3 className="font-semibold">Phase actions</h3>
          <div className="mt-3 flex flex-wrap gap-2">{tradeActions.transitions.map(a=>{
            const approval=approvedByAction.get(a.action);
            return <button key={a.to} className="roviq-btn-secondary" disabled={busy!==null||Boolean(a.approvalRecommended&&!approval)} onClick={()=>void moveTrade(a)}>
              {busy===`trade:${a.to}`?'Applying…':pretty(a.to)}{a.approvalRecommended&&!approval?' · approval required':''}
            </button>;
          })}{tradeActions.transitions.length===0&&<span className="roviq-muted text-sm">No further TradeCase phase actions.</span>}</div>
          <h3 className="mt-5 font-semibold">Milestone gates</h3>
          <div className="mt-2 space-y-2">{trade.milestones.map(m=><div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"><div><strong className="text-sm">{pretty(m.milestone_code)}</strong><div className="mt-1"><StatusBadge state={m.state}/></div></div>{!['completed','waived'].includes(m.state)&&<div className="flex gap-2"><button className="roviq-btn-secondary text-sm" disabled={busy!==null} onClick={()=>void milestone(m.milestone_code,'completed')}>Complete</button><button className="roviq-btn-secondary text-sm" disabled={busy!==null} onClick={()=>void milestone(m.milestone_code,'waived')}>Waive</button></div>}</div>)}</div>
        </div>
        <div>
          <h3 className="font-semibold">Documents</h3>
          <div className="mt-2 space-y-2">{trade.documents.length===0&&<p className="roviq-muted text-sm">No trade documents recorded.</p>}{trade.documents.map(d=><div key={d.id} className="rounded-lg border border-slate-200 p-3"><div className="flex justify-between gap-2"><strong className="text-sm">{pretty(d.document_type)}</strong><StatusBadge state={d.status}/></div>{d.external_reference&&<p className="mt-1 break-all text-xs roviq-muted">{d.external_reference}</p>}</div>)}</div>
          <div className="mt-4 grid gap-2"><input className="roviq-input" value={docType} onChange={e=>setDocType(e.target.value)} placeholder="Document type (e.g. title, invoice, AES)" /><input className="roviq-input" value={docRef} onChange={e=>setDocRef(e.target.value)} placeholder="External reference or URL (optional)" /><button className="roviq-btn-secondary justify-self-start" disabled={busy!==null||!docType.trim()} onClick={()=>void addDocument()}>{busy==='document'?'Adding…':'Add document'}</button></div>
        </div>
      </div>
    </section>}

    <section className="grid gap-5 lg:grid-cols-2">
      <div className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><h2 className="font-semibold">Workflow & recovery</h2></div><div className="divide-y divide-slate-200">{sagas.length===0&&<p className="p-4 roviq-muted">No saga attached.</p>}{sagas.map(s=><div key={s.id} className="p-4"><div className="flex justify-between"><strong>{pretty(s.saga_type)}</strong><StatusBadge state={s.state}/></div><p className="mt-1 text-sm roviq-muted">{s.current_step??'No current step'} · updated {formatDateTime(s.updated_at)}</p>{s.last_error&&<p className="mt-2 text-sm text-red-700">{s.last_error}</p>}</div>)}</div></div>
      <div className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><h2 className="font-semibold">Approvals</h2></div><div className="divide-y divide-slate-200">{approvals.length===0&&<p className="p-4 roviq-muted">No approvals.</p>}{approvals.map(a=><div key={a.id} className="p-4"><div className="flex justify-between"><strong>{pretty(a.approval_type)}</strong><StatusBadge state={a.state}/></div><p className="mt-1 text-sm roviq-muted">{a.action} · {formatDateTime(a.created_at)}</p>{a.state==='pending'&&<div className="mt-3 flex gap-2"><button className="roviq-btn-secondary text-sm" disabled={busy!==null} onClick={()=>void decide(a.id,'approved')}>Approve</button><button className="roviq-btn-secondary text-sm" disabled={busy!==null} onClick={()=>void decide(a.id,'rejected')}>Reject</button></div>}</div>)}</div></div>
    </section>

    <section className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><h2 className="font-semibold">Immutable timeline</h2></div><div className="divide-y divide-slate-200">{data.events.map(e=><div key={e.id} className="p-4"><div className="flex justify-between gap-3"><strong>{pretty(e.event_type)}</strong><span className="text-xs roviq-muted">v{e.new_version} · {formatDateTime(e.occurred_at)}</span></div><pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-slate-600">{JSON.stringify(e.payload,null,2)}</pre></div>)}</div></section>
    <Link to="/core-cases" className="roviq-btn-secondary inline-flex">Back to Core Cases</Link>
  </div>;
}
