import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';

type CoreCase={id:string;case_type:string;state:string;priority:string;version:number;updated_at:string;open_sagas:number;pending_approvals:number;last_event_at:string|null};

export function CoreCases(){
  const [rows,setRows]=useState<CoreCase[]|null>(null);const [state,setState]=useState('');const [caseType,setCaseType]=useState('');const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let live=true;const p=new URLSearchParams();if(state)p.set('state',state);if(caseType)p.set('caseType',caseType);setRows(null);setError(null);
    api.get<{cases:CoreCase[]}>(`/api/core/operations/cases?${p.toString()}`).then(r=>{if(live)setRows(r.cases)}).catch(()=>{if(live)setError('Could not load Core Cases.')});return()=>{live=false}},[state,caseType]);
  return <div className="space-y-5">
    <section className="ops-hero"><div><p className="roviq-kicker">Authoritative Case model</p><h1>Core Cases</h1><p className="roviq-muted">Maintenance, transport, mobility, fleet and trade on one Case surface.</p></div>
      <div className="flex flex-wrap gap-2"><select className="roviq-input ops-filter" value={caseType} onChange={e=>setCaseType(e.target.value)}><option value="">All domains</option>{['maintenance','transport','mobility','fleet','trade'].map(v=><option key={v}>{v}</option>)}</select><input className="roviq-input ops-filter" placeholder="State" value={state} onChange={e=>setState(e.target.value)}/></div>
    </section>
    {error&&<div className="ops-error">{error}</div>}
    <section className="ops-case-grid">
      {rows===null&&<div className="roviq-panel p-5 roviq-muted">Loading Core Cases…</div>}
      {rows?.map(c=><Link key={c.id} to={`/core-cases/${c.id}`} className="ops-case-card">
        <div className="ops-case-top"><div><p className="roviq-kicker">{c.case_type} · v{c.version}</p><h2>Case {c.id.slice(0,8)}</h2></div><StatusBadge state={c.state}/></div>
        <div className="ops-case-meta"><span className={`ops-priority priority-${c.priority}`}>{c.priority}</span><span>Updated {formatDateTime(c.updated_at)}</span></div>
        <p className="roviq-muted text-sm">{c.open_sagas} active workflow(s) · {c.pending_approvals} approval(s) pending</p>
        <div className="ops-open-row"><span>Open Case Workspace</span><strong>›</strong></div>
      </Link>)}
      {rows&&rows.length===0&&<div className="roviq-panel p-5 roviq-muted">No Core Cases match these filters.</div>}
    </section>
  </div>;
}
