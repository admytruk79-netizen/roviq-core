import { useEffect,useState } from 'react';
import { Link,useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';

type CoreCase=Record<string,unknown>&{id:string;case_type:string;state:string;priority:string;version:number;updated_at:string};
type Event={id:string;event_type:string;actor_id:string|null;occurred_at:string;payload:Record<string,unknown>;new_version:number};
type Approval={id:string;approval_type:string;action:string;state:string;created_at:string;decided_at:string|null};
type Saga={id:string;saga_type:string;state:string;current_step:string|null;updated_at:string;last_error:string|null};

export function CoreCaseWorkspace(){
  const {id}=useParams();const [data,setData]=useState<{case:CoreCase;events:Event[]}|null>(null);const [approvals,setApprovals]=useState<Approval[]>([]);const [sagas,setSagas]=useState<Saga[]>([]);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{if(!id)return;let live=true;setError(null);Promise.all([
    api.get<{case:CoreCase;events:Event[]}>(`/api/core/cases/${id}`),
    api.get<{approvals:Approval[]}>(`/api/core/cases/${id}/approvals`),
    api.get<{sagas:Saga[]}>(`/api/core/cases/${id}/sagas`)
  ]).then(([c,a,s])=>{if(live){setData(c);setApprovals(a.approvals);setSagas(s.sagas)}}).catch(()=>{if(live)setError('Could not load the Case Workspace.')});return()=>{live=false}},[id]);
  if(error)return <div className="ops-error">{error}</div>;
  if(!data)return <div className="roviq-panel p-5 roviq-muted">Loading Case Workspace…</div>;
  const c=data.case;
  return <div className="space-y-5">
    <section className="ops-hero"><div><p className="roviq-kicker">{c.case_type} · Case Workspace</p><h1>Case {c.id.slice(0,8)}</h1><p className="roviq-muted">Authoritative state, workflows, approvals and immutable event history.</p></div><div className="flex items-center gap-2"><StatusBadge state={c.state}/><span className="roviq-btn-secondary">v{c.version}</span></div></section>
    <section className="grid gap-4 md:grid-cols-4">
      <div className="roviq-panel p-4"><p className="roviq-kicker">State</p><p className="mt-2 font-semibold">{c.state}</p></div>
      <div className="roviq-panel p-4"><p className="roviq-kicker">Priority</p><p className="mt-2 font-semibold">{c.priority}</p></div>
      <div className="roviq-panel p-4"><p className="roviq-kicker">Approvals</p><p className="mt-2 font-semibold">{approvals.filter(a=>a.state==='pending').length} pending</p></div>
      <div className="roviq-panel p-4"><p className="roviq-kicker">Workflows</p><p className="mt-2 font-semibold">{sagas.filter(s=>!['completed','cancelled'].includes(s.state)).length} active</p></div>
    </section>
    <section className="grid gap-5 lg:grid-cols-2">
      <div className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><h2 className="font-semibold">Workflow & recovery</h2></div><div className="divide-y divide-slate-200">{sagas.length===0&&<p className="p-4 roviq-muted">No saga attached.</p>}{sagas.map(s=><div key={s.id} className="p-4"><div className="flex justify-between"><strong>{s.saga_type.replaceAll('_',' ')}</strong><StatusBadge state={s.state}/></div><p className="mt-1 text-sm roviq-muted">{s.current_step??'No current step'} · updated {formatDateTime(s.updated_at)}</p>{s.last_error&&<p className="mt-2 text-sm text-red-700">{s.last_error}</p>}</div>)}</div></div>
      <div className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><h2 className="font-semibold">Approvals</h2></div><div className="divide-y divide-slate-200">{approvals.length===0&&<p className="p-4 roviq-muted">No approvals.</p>}{approvals.map(a=><div key={a.id} className="p-4"><div className="flex justify-between"><strong>{a.approval_type.replaceAll('_',' ')}</strong><StatusBadge state={a.state}/></div><p className="mt-1 text-sm roviq-muted">{a.action} · {formatDateTime(a.created_at)}</p></div>)}</div></div>
    </section>
    <section className="roviq-panel overflow-hidden"><div className="border-b border-slate-200 p-4"><h2 className="font-semibold">Immutable timeline</h2></div><div className="divide-y divide-slate-200">{data.events.map(e=><div key={e.id} className="p-4"><div className="flex justify-between gap-3"><strong>{e.event_type.replaceAll('_',' ')}</strong><span className="text-xs roviq-muted">v{e.new_version} · {formatDateTime(e.occurred_at)}</span></div><pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-slate-600">{JSON.stringify(e.payload,null,2)}</pre></div>)}</div></section>
    <Link to="/core-cases" className="roviq-btn-secondary inline-flex">Back to Core Cases</Link>
  </div>;
}
