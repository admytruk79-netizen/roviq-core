import { useCallback,useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateTime,humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';

type CoreCase={id:string;case_type:string;state:string;priority:string;created_at:string;updated_at:string;pending_approvals:number;active_workflows:number};

export function CoreCases(){
  const[cases,setCases]=useState<CoreCase[]|null>(null);
  const[error,setError]=useState<string|null>(null);
  const[loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);setError(null);try{const r=await api.get<{cases:CoreCase[]}>('/api/core/me/cases');setCases(r.cases)}catch{setError('Could not load your coordinated cases.')}finally{setLoading(false)}},[]);
  useEffect(()=>{void load()},[load]);
  const active=cases?.filter(c=>!['completed','cancelled','expired'].includes(c.state)).length??0;
  return <div className="space-y-5" aria-busy={loading}>
    <section className="roviq-customer-hero"><div><p className="roviq-kicker">ROVIQ Core</p><h1>Coordinated cases</h1><p className="roviq-muted">Track maintenance, transport, mobility and trade work coordinated through the universal ROVIQ Case.</p></div></section>
    <section className="roviq-summary-strip"><div><span>Active</span><strong>{active}</strong></div><div><span>Total</span><strong>{cases?.length??'—'}</strong></div><div><span>Approvals</span><strong>{cases?.reduce((n,c)=>n+Number(c.pending_approvals||0),0)??'—'}</strong></div></section>
    {error&&<div className="roviq-error"><span>{error}</span><button className="roviq-btn-secondary" onClick={()=>void load()}>Try again</button></div>}
    {cases===null&&!error&&<div className="roviq-panel p-5 text-sm roviq-muted">Loading coordinated cases…</div>}
    {cases&&cases.length===0&&<section className="roviq-panel roviq-empty-state"><p className="roviq-kicker">No Core cases</p><h2>Nothing is being coordinated here yet.</h2><p className="roviq-muted">When a universal ROVIQ Case is opened for you, it will appear here.</p></section>}
    {cases&&cases.length>0&&<section className="roviq-case-list">{cases.map(c=><Link key={c.id} to={`/core-cases/${c.id}`} className="roviq-case-card"><div className="roviq-case-copy"><p className="roviq-kicker">{humanizeToken(c.case_type)} case</p><h2>Case {c.id.slice(0,8)}</h2><p className="roviq-muted">Updated {formatDateTime(c.updated_at)} · {c.active_workflows} active workflow(s)</p></div><div className="roviq-case-status"><StatusBadge state={c.state}/><span aria-hidden="true">›</span></div></Link>)}</section>}
  </div>
}
