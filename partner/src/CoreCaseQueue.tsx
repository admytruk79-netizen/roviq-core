import { useEffect,useMemo,useState } from 'react';
import { api } from './api';

type CoreCase={id:string;case_type:string;state:string;priority:string;version:number;updated_at:string;pending_approvals:number;active_workflows:number};
type Approval={id:string;approval_type:string;action:string;state:string;created_at:string};
type Action={to:string;action:string;approvalRecommended:boolean};
type Actions={version:number;transitions:Action[]};

function human(v:string){return v.replaceAll('_',' ').replace(/\b\w/g,m=>m.toUpperCase())}
function tone(state:string){if(['failed','blocked','cancelled'].includes(state))return'border-red-400/20 bg-red-500/10 text-red-200';if(['completed','active','approved'].includes(state))return'border-[rgba(140,255,31,.2)] bg-[rgba(140,255,31,.07)] text-[var(--green)]';if(['needs_review','waiting_external','pending'].includes(state))return'border-amber-400/20 bg-amber-500/10 text-amber-200';return'border-white/10 bg-white/[.04] text-white/75'}

export function CoreCaseQueue(){
  const[cases,setCases]=useState<CoreCase[]>([]);
  const[selected,setSelected]=useState<string|null>(null);
  const[approvals,setApprovals]=useState<Approval[]>([]);
  const[actions,setActions]=useState<Actions|null>(null);
  const[error,setError]=useState<string|null>(null);
  const[busy,setBusy]=useState<string|null>(null);
  const[refresh,setRefresh]=useState(0);

  useEffect(()=>{let live=true;(async()=>{try{setError(null);const r=await api.get<{cases:CoreCase[]}>('/api/core/me/cases');if(!live)return;setCases(r.cases);setSelected(cur=>cur&&r.cases.some(c=>c.id===cur)?cur:r.cases[0]?.id??null)}catch(e){if(live)setError(e instanceof Error?e.message:'Unable to load Core cases')}})();return()=>{live=false}},[refresh]);

  useEffect(()=>{if(!selected){setApprovals([]);setActions(null);return}let live=true;Promise.all([
    api.get<{approvals:Approval[]}>(`/api/core/cases/${selected}/approvals`),
    api.get<Actions>(`/api/core/cases/${selected}/actions`)
  ]).then(([a,x])=>{if(live){setApprovals(a.approvals);setActions(x)}}).catch(e=>{if(live)setError(e instanceof Error?e.message:'Unable to load case actions')});return()=>{live=false}},[selected,refresh]);

  const selectedCase=cases.find(c=>c.id===selected)??null;
  const approved=useMemo(()=>new Map(approvals.filter(a=>a.state==='approved').map(a=>[a.action,a])),[approvals]);

  async function transition(action:Action){
    if(!selected||!actions)return;
    setBusy(action.to);setError(null);
    try{
      const approval=approved.get(action.action);
      await api.postWithHeaders(`/api/core/cases/${selected}/transition`,{
        expectedVersion:actions.version,requestedTransition:action.to,approvalId:approval?.id,
        evidence:{source:'partner_core_workspace'}
      },{'idempotency-key':crypto.randomUUID()});
      setRefresh(v=>v+1);
    }catch(e){setError(e instanceof Error?e.message:'Unable to update case')}finally{setBusy(null)}
  }

  return <section className="mt-8" aria-labelledby="core-cases-heading">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><p className="kicker">ROVIQ Core</p><h2 id="core-cases-heading" className="mt-1 text-2xl font-bold">Coordinated Cases</h2><p className="muted mt-1 max-w-2xl text-sm">Cases currently assigned to your operation through the universal ROVIQ workflow.</p></div><button className="secondary" onClick={()=>setRefresh(v=>v+1)}>Refresh</button></div>
    {error&&<div className="mb-4 rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">{human(error)}</div>}
    <div className="grid gap-5 xl:grid-cols-[.9fr_1.4fr]">
      <div className="panel overflow-hidden">
        <div className="border-b border-white/10 p-4"><span className="kicker">{cases.length} assigned</span></div>
        <div className="divide-y divide-white/10">{cases.length===0&&<p className="muted p-5 text-sm">No universal Core Cases are assigned to this operation.</p>}{cases.map(c=><button key={c.id} onClick={()=>setSelected(c.id)} className={`w-full p-4 text-left transition hover:bg-white/[.03] ${selected===c.id?'bg-white/[.04]':''}`}><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{human(c.case_type)} · {c.id.slice(0,8)}</p><p className="muted mt-1 text-xs">{c.active_workflows} workflow(s) · {c.pending_approvals} approval(s)</p></div><span className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${tone(c.state)}`}>{human(c.state)}</span></div></button>)}</div>
      </div>
      <div className="panel p-5">
        {!selectedCase?<p className="muted text-sm">Select a Case to work it.</p>:<>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="kicker">{human(selectedCase.case_type)} Case</p><h3 className="mt-1 text-xl font-bold">Case {selectedCase.id.slice(0,8)}</h3><p className="muted mt-1 text-sm">Priority {human(selectedCase.priority)} · Core v{selectedCase.version}</p></div><span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${tone(selectedCase.state)}`}>{human(selectedCase.state)}</span></div>
          <div className="mt-5"><p className="kicker">Available actions</p><div className="mt-3 flex flex-wrap gap-2">{actions?.transitions.map(a=>{const ok=!a.approvalRecommended||approved.has(a.action);return <button key={a.to} className="secondary" disabled={busy!==null||!ok} onClick={()=>void transition(a)}>{busy===a.to?'Applying…':human(a.to)}{!ok?' · approval required':''}</button>})}{actions&&actions.transitions.length===0&&<span className="muted text-sm">No transitions available.</span>}</div></div>
          <div className="mt-6"><p className="kicker">Approvals</p><div className="mt-2 space-y-2">{approvals.length===0&&<p className="muted text-sm">No approval records.</p>}{approvals.map(a=><div key={a.id} className="rounded-xl border border-white/10 p-3"><div className="flex justify-between gap-3"><div><p className="text-sm font-semibold">{human(a.approval_type)}</p><p className="muted mt-1 text-xs">{human(a.action)}</p></div><span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${tone(a.state)}`}>{human(a.state)}</span></div></div>)}</div></div>
        </>}
      </div>
    </div>
  </section>
}
