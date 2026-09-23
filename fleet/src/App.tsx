import{useEffect,useMemo,useState,type FormEvent}from'react';

type Principal={role:string;actorId?:string|null};
type Allocation={id:string;case_id:string;allocation_type:string;state:string;resource_id:string|null;return_due_at:string|null;notes:string|null;updated_at:string};
type CoreCase={id:string;case_type:string;state:string;priority:string;version:number;updated_at:string;pending_approvals:number;active_workflows:number};
type Approval={id:string;approval_type:string;action:string;state:string};
type Action={to:string;action:string;approvalRecommended:boolean};
type Actions={version:number;transitions:Action[]};

const BASE=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'');
const TOKEN='roviq_fleet_token',PRINCIPAL='roviq_fleet_principal';

async function req<T>(path:string,init:RequestInit={}):Promise<T>{
  const token=localStorage.getItem(TOKEN);
  const r=await fetch(`${BASE}${path}`,{cache:'no-store',...init,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...(init.headers??{})}});
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error??`request_failed_${r.status}`)}
  return r.json()
}
const human=(v:string)=>v.replaceAll('_',' ').replace(/\b\w/g,m=>m.toUpperCase());
function badge(state:string){return <span className={`badge badge-${state}`}>{human(state)}</span>}

export default function App(){
 const[principal,setPrincipal]=useState<Principal|null>(()=>{try{return JSON.parse(localStorage.getItem(PRINCIPAL)??'null')}catch{return null}});
 const[email,setEmail]=useState(''),[password,setPassword]=useState(''),[show,setShow]=useState(false),[loginBusy,setLoginBusy]=useState(false);
 const[allocations,setAllocations]=useState<Allocation[]>([]),[cases,setCases]=useState<CoreCase[]>([]);
 const[selected,setSelected]=useState<string|null>(null),[actions,setActions]=useState<Actions|null>(null),[approvals,setApprovals]=useState<Approval[]>([]);
 const[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[refresh,setRefresh]=useState(0);

 async function login(e:FormEvent){e.preventDefault();setLoginBusy(true);setError('');try{
   const first=await req<{accessToken:string;principal:Principal}>('/api/auth/login',{method:'POST',body:JSON.stringify({email:email.trim(),password})});
   let session=first;
   if(first.principal.role==='admin'){localStorage.setItem(TOKEN,first.accessToken);session=await req<{accessToken:string;principal:Principal}>('/api/admin/testing/fleet-session',{method:'POST',body:'{}'})}
   if(session.principal.role!=='fleet'||!session.principal.actorId)throw new Error('This portal requires a fleet or mobility-provider account.');
   localStorage.setItem(TOKEN,session.accessToken);localStorage.setItem(PRINCIPAL,JSON.stringify(session.principal));setPrincipal(session.principal);
 }catch(e){localStorage.removeItem(TOKEN);localStorage.removeItem(PRINCIPAL);setError(e instanceof Error?e.message:'Unable to sign in')}finally{setLoginBusy(false)}}

 useEffect(()=>{if(!principal)return;let live=true;(async()=>{try{
   setError('');const[a,c]=await Promise.all([req<{allocations:Allocation[]}>('/api/mobility/me/allocations'),req<{cases:CoreCase[]}>('/api/core/me/cases')]);
   if(!live)return;setAllocations(a.allocations);setCases(c.cases);setSelected(cur=>cur&&c.cases.some(x=>x.id===cur)?cur:c.cases[0]?.id??null);
 }catch(e){if(live)setError(e instanceof Error?e.message:'Unable to load fleet workspace')}})();return()=>{live=false}},[principal,refresh]);

 useEffect(()=>{if(!selected){setActions(null);setApprovals([]);return}let live=true;Promise.all([
   req<Actions>(`/api/core/cases/${selected}/actions`),
   req<{approvals:Approval[]}>(`/api/core/cases/${selected}/approvals`)
 ]).then(([a,p])=>{if(live){setActions(a);setApprovals(p.approvals)}}).catch(e=>{if(live)setError(e instanceof Error?e.message:'Unable to load Case actions')});return()=>{live=false}},[selected,refresh]);

 const selectedCase=cases.find(c=>c.id===selected)??null;
 const approved=useMemo(()=>new Map(approvals.filter(a=>a.state==='approved').map(a=>[a.action,a])),[approvals]);

 async function allocationState(id:string,state:'active'|'return_pending'|'completed'|'declined'|'cancelled'|'failed'){
   setBusy(`allocation:${id}`);setError('');setNotice('');try{await req(`/api/mobility/${id}/state`,{method:'POST',body:JSON.stringify({state})});setNotice(`Allocation marked ${human(state)}.`);setRefresh(v=>v+1)}catch(e){setError(e instanceof Error?e.message:'Unable to update allocation')}finally{setBusy('')}
 }
 async function move(a:Action){if(!selected||!actions)return;setBusy(`case:${a.to}`);setError('');setNotice('');try{
   const approval=approved.get(a.action);
   await req(`/api/core/cases/${selected}/transition`,{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({expectedVersion:actions.version,requestedTransition:a.to,approvalId:approval?.id,evidence:{source:'fleet_core_workspace'}})});
   setNotice(`Case moved to ${human(a.to)}.`);setRefresh(v=>v+1)
 }catch(e){setError(e instanceof Error?e.message:'Unable to update Case')}finally{setBusy('')}}
 function logout(){localStorage.removeItem(TOKEN);localStorage.removeItem(PRINCIPAL);setPrincipal(null)}

 if(!principal)return <div className="shell login"><form className="panel login-card" onSubmit={login}><Brand/><span className="eyebrow">Fleet & Mobility</span><h1>Sign in</h1><p>Manage mobility allocations and the ROVIQ Cases assigned to your operation.</p><label>Email<input required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<div className="password"><input required type={show?'text':'password'} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/><button type="button" onClick={()=>setShow(v=>!v)}>{show?'Hide':'Show'}</button></div></label>{error&&<div className="error">{human(error)}</div>}<button className="primary wide" disabled={loginBusy}>{loginBusy?'Signing in…':'Enter Fleet workspace'}</button></form></div>;

 return <div className="shell"><header><Brand/><div><span>Fleet & Mobility</span><button className="secondary" onClick={()=>setRefresh(v=>v+1)}>Refresh</button><button className="secondary" onClick={logout}>Sign out</button></div></header><main>
   <section className="hero"><div><span className="eyebrow">ROVIQ Core</span><h1>Fleet & Mobility Workspace</h1><p>One operational surface for assigned mobility work and universal Core Cases.</p></div><div className="metric"><b>{allocations.length}</b><span>active allocations</span></div></section>
   {error&&<div className="error">{human(error)}</div>}{notice&&<div className="notice">{notice}</div>}

   <section className="section"><div className="section-head"><div><span className="eyebrow">Mobility</span><h2>Active allocations</h2></div></div>
   {allocations.length===0?<div className="panel empty"><h3>No active mobility allocations</h3><p>Assignments will appear here when Core allocates a loaner, rental, shuttle or other mobility service.</p></div>:<div className="grid">{allocations.map(a=><article className="panel card" key={a.id}><div className="card-top"><div><span className="eyebrow">{human(a.allocation_type)}</span><h3>Allocation {a.id.slice(0,8)}</h3><p>Case {a.case_id.slice(0,8)}</p></div>{badge(a.state)}</div><div className="actions">{a.state==='assigned'&&<><button className="primary" disabled={Boolean(busy)} onClick={()=>void allocationState(a.id,'active')}>Accept & activate</button><button className="secondary" disabled={Boolean(busy)} onClick={()=>void allocationState(a.id,'declined')}>Decline</button></>}{a.state==='active'&&<button className="primary" disabled={Boolean(busy)} onClick={()=>void allocationState(a.id,'return_pending')}>Begin return</button>}{a.state==='return_pending'&&<button className="primary" disabled={Boolean(busy)} onClick={()=>void allocationState(a.id,'completed')}>Complete return</button>}{['assigned','active','return_pending'].includes(a.state)&&<button className="secondary danger" disabled={Boolean(busy)} onClick={()=>void allocationState(a.id,'failed')}>Report issue</button>}</div></article>)}</div>}</section>

   <section className="section"><div className="section-head"><div><span className="eyebrow">Universal Case queue</span><h2>Assigned Core Cases</h2><p>These are the authoritative Cases currently owned by this fleet actor.</p></div></div>
   <div className="workspace"><div className="panel queue">{cases.length===0?<div className="empty"><p>No Core Cases assigned.</p></div>:cases.map(c=><button key={c.id} className={`queue-row ${selected===c.id?'active':''}`} onClick={()=>setSelected(c.id)}><div><strong>{human(c.case_type)} · {c.id.slice(0,8)}</strong><span>{c.active_workflows} workflow(s) · {c.pending_approvals} approval(s)</span></div>{badge(c.state)}</button>)}</div>
   <div className="panel detail">{!selectedCase?<div className="empty"><p>Select an assigned Case.</p></div>:<><div className="card-top"><div><span className="eyebrow">{human(selectedCase.case_type)} Case</span><h3>Case {selectedCase.id.slice(0,8)}</h3><p>Priority {human(selectedCase.priority)} · Core v{selectedCase.version}</p></div>{badge(selectedCase.state)}</div><h4>Available Case actions</h4><div className="actions">{actions?.transitions.map(a=>{const ok=!a.approvalRecommended||approved.has(a.action);return <button key={a.to} className="secondary" disabled={Boolean(busy)||!ok} onClick={()=>void move(a)}>{busy===`case:${a.to}`?'Applying…':human(a.to)}{!ok?' · approval required':''}</button>})}{actions&&actions.transitions.length===0&&<span className="muted">No transitions available.</span>}</div><h4>Approval records</h4><div className="approval-list">{approvals.length===0?<p className="muted">No approvals.</p>:approvals.map(a=><div key={a.id} className="approval"><div><strong>{human(a.approval_type)}</strong><span>{human(a.action)}</span></div>{badge(a.state)}</div>)}</div></>}</div></div></section>
 </main></div>
}
function Brand(){return <div className="brand"><span className="mark">R</span><span>ROVIQ</span></div>}
