import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';

type Summary={total:number;active:number;priority_watch:number;attention:number;active_trade:number;pendingApprovals:number;outboxReady:number;failedIntegrations:number};
type AttentionCase={id:string;case_type:string;state:string;priority:string;updated_at:string};

export function CommandCenter(){
  const [data,setData]=useState<{summary:Summary;attentionCases:AttentionCase[]}|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{let live=true;setError(null);api.get<{summary:Summary;attentionCases:AttentionCase[]}>('/api/core/operations/command-center')
    .then(r=>{if(live)setData(r)}).catch(()=>{if(live)setError('Could not load the Core command center.')});return()=>{live=false}},[refresh]);
  return <div className="space-y-5">
    <section className="ops-hero">
      <div><p className="roviq-kicker">ROVIQ Core</p><h1>Command Center</h1><p className="roviq-muted">One operational view across universal Cases, approvals, integrations and recovery states.</p></div>
      <div className="flex gap-2"><Link className="roviq-btn-secondary" to="/core-cases">Open Core Cases</Link><button className="roviq-btn-secondary" onClick={()=>setRefresh(v=>v+1)}>Refresh</button></div>
    </section>
    {error&&<div className="ops-error" role="alert">{error}</div>}
    <section className="ops-stats" aria-label="Core operating summary">
      <div><span>Active</span><strong>{data?.summary.active??'—'}</strong></div>
      <div><span>Attention</span><strong>{data?.summary.attention??'—'}</strong></div>
      <div><span>Priority watch</span><strong>{data?.summary.priority_watch??'—'}</strong></div>
      <div><span>Trade</span><strong>{data?.summary.active_trade??'—'}</strong></div>
    </section>
    <section className="grid gap-4 md:grid-cols-3">
      <div className="roviq-panel p-5"><p className="roviq-kicker">Approvals</p><div className="mt-2 text-3xl font-bold">{data?.summary.pendingApprovals??'—'}</div><p className="roviq-muted text-sm">Pending explicit decisions</p></div>
      <div className="roviq-panel p-5"><p className="roviq-kicker">Event delivery</p><div className="mt-2 text-3xl font-bold">{data?.summary.outboxReady??'—'}</div><p className="roviq-muted text-sm">Outbox events ready to publish</p></div>
      <div className="roviq-panel p-5"><p className="roviq-kicker">Integrations</p><div className="mt-2 text-3xl font-bold">{data?.summary.failedIntegrations??'—'}</div><p className="roviq-muted text-sm">Failed inbound connector events</p></div>
    </section>
    <section className="roviq-panel overflow-hidden">
      <div className="border-b border-slate-200 p-4"><p className="roviq-kicker">Needs attention</p><h2 className="text-lg font-semibold">Exception queue</h2></div>
      <div className="divide-y divide-slate-200">
        {!data&&<div className="p-5 roviq-muted">Loading Core operations…</div>}
        {data&&data.attentionCases.length===0&&<div className="p-5 roviq-muted">No Core Cases currently require attention.</div>}
        {data?.attentionCases.map(c=><Link key={c.id} to={`/core-cases/${c.id}`} className="flex items-center justify-between gap-4 p-4 hover:bg-slate-50">
          <div><p className="font-semibold">Case {c.id.slice(0,8)}</p><p className="roviq-muted text-sm">{c.case_type.replaceAll('_',' ')} · {c.priority} · updated {formatDateTime(c.updated_at)}</p></div>
          <StatusBadge state={c.state}/>
        </Link>)}
      </div>
    </section>
  </div>;
}
