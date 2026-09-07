import {useCallback,useEffect,useMemo,useState} from 'react';
import {api} from './api';

type RepairOrder={id:string;repair_order_number:string;status:string;customer_concern?:string|null;updated_at:string};
type Inspection={id:string;status:string;inspection_type:string;summary?:string|null;technician_actor_id?:string|null;created_at:string};
type Finding={id:string;inspection_id:string;section:string;item:string;severity:'good'|'attention'|'urgent'|'not_inspected';measurement?:string|null;technician_note?:string|null};
type WorkItem={id:string;title:string;status:string;technician_actor_id?:string|null;technician_resource_id?:string|null;bay_resource_id?:string|null;blocked_reason?:string|null;estimated_minutes?:number|null;started_at?:string|null;completed_at?:string|null};
type TimeEntry={id:string;work_item_id:string;technician_actor_id:string;started_at:string;ended_at?:string|null};
type Floor={repairOrder:RepairOrder;inspections:Inspection[];findings:Finding[];workItems:WorkItem[];timeEntries:TimeEntry[];summary:{inspectionCount:number;submittedInspections:number;urgentFindings:number;openWorkItems:number;activeClocks:number;laborMinutes:number}};
type WorkAction='start'|'pause'|'wait_parts'|'wait_customer'|'resume'|'qc'|'complete'|'cancel';

function human(v:string|null|undefined){return v?v.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'—'}
function roRank(status:string){const order:Record<string,number>={waiting_parts:0,waiting_customer:0,quality_control:1,in_progress:2,approved:3,awaiting_approval:4,estimate_pending:5,draft:6,completed:7,closed:8,cancelled:9};return order[status]??10}
function workNext(item:WorkItem):{label:string;action:WorkAction}|null{
  if(item.status==='assigned'||item.status==='paused') return {label:'Start work',action:'start'};
  if(item.status==='waiting_parts'||item.status==='waiting_customer') return {label:'Resume work',action:'resume'};
  if(item.status==='in_progress') return {label:'Send to QC',action:'qc'};
  if(item.status==='quality_control') return {label:'Complete work',action:'complete'};
  return null;
}

export function ShopFloorWorkspace(){
  const[orders,setOrders]=useState<RepairOrder[]>([]);
  const[selectedId,setSelectedId]=useState<string|null>(null);
  const[floor,setFloor]=useState<Floor|null>(null);
  const[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState<string|null>(null);
  const[message,setMessage]=useState<string|null>(null);
  const[error,setError]=useState<string|null>(null);
  const[section,setSection]=useState('General');
  const[item,setItem]=useState('');
  const[severity,setSeverity]=useState<Finding['severity']>('good');

  const activeOrders=useMemo(()=>[...orders].filter(o=>!['closed','cancelled'].includes(o.status)).sort((a,b)=>roRank(a.status)-roRank(b.status)||new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime()),[orders]);
  const activeInspection=useMemo(()=>floor?.inspections.find(i=>['draft','in_progress'].includes(i.status))??null,[floor]);
  const submittedInspection=useMemo(()=>floor?.inspections.find(i=>i.status==='submitted')??null,[floor]);

  const loadOrders=useCallback(async()=>{
    const r=await api.get<{repairOrders:RepairOrder[]}>('/api/shop-os/repair-orders');
    setOrders(r.repairOrders);
    const candidates=r.repairOrders.filter(o=>!['closed','cancelled'].includes(o.status)).sort((a,b)=>roRank(a.status)-roRank(b.status)||new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime());
    setSelectedId(current=>current&&candidates.some(o=>o.id===current)?current:(candidates[0]?.id??null));
  },[]);

  const loadFloor=useCallback(async(id:string)=>{
    const f=await api.get<Floor>(`/api/shop-os/repair-orders/${id}/floor`);
    setFloor(f);
  },[]);

  useEffect(()=>{let cancelled=false;(async()=>{setLoading(true);setError(null);try{await loadOrders()}catch(e){if(!cancelled)setError(`Floor could not load: ${human(e instanceof Error?e.message:'request failed')}`)}finally{if(!cancelled)setLoading(false)}})();return()=>{cancelled=true}},[loadOrders]);
  useEffect(()=>{if(!selectedId){setFloor(null);return;}void loadFloor(selectedId).catch(e=>setError(`Floor could not load: ${human(e instanceof Error?e.message:'request failed')}`))},[selectedId,loadFloor]);

  async function refresh(){if(!selectedId)return;await Promise.all([loadOrders(),loadFloor(selectedId)])}
  async function run(key:string,action:()=>Promise<unknown>,success:string){setBusy(key);setError(null);setMessage(null);try{await action();setMessage(success);await refresh()}catch(e){setError(human(e instanceof Error?e.message:'request failed'))}finally{setBusy(null)}}
  async function startDvi(){if(!selectedId)return;await run('dvi-start',()=>api.post(`/api/shop-os/repair-orders/${selectedId}/dvi`,{inspectionType:'general'}),'Inspection started. Add findings, then submit it for the service record.')}
  async function addFinding(){if(!activeInspection||!item.trim())return;await run('dvi-finding',()=>api.post(`/api/shop-os/dvi/${activeInspection.id}/findings`,{section:section.trim()||'General',item:item.trim(),severity}),'Inspection finding saved.');setItem('')}
  async function submitDvi(){if(!activeInspection)return;await run('dvi-submit',()=>api.patch(`/api/shop-os/dvi/${activeInspection.id}/submit`,{}),'Inspection submitted and locked into the service record.')}
  async function updateWork(w:WorkItem,action:WorkAction){await run(`work-${w.id}`,()=>api.patch(`/api/shop-os/work-items/${w.id}`,{action}),`${human(action)} recorded.`)}
  async function clockIn(w:WorkItem){await run(`clock-${w.id}`,()=>api.post(`/api/shop-os/work-items/${w.id}/clock-in`,{}),'Technician time started.')}
  async function clockOut(w:WorkItem){await run(`clock-${w.id}`,()=>api.post(`/api/shop-os/work-items/${w.id}/clock-out`,{endReason:'manual'}),'Technician time stopped.')}

  if(!loading&&activeOrders.length===0)return null;
  return <section className="mt-8 shop-floor-zero-training" id="shop-os-floor-workspace">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="kicker">Fixed operations</p><h2 className="mt-1 text-2xl font-bold">Shop floor</h2><p className="muted mt-1 max-w-2xl text-sm">Inspection, technician work, time and quality control stay attached to the repair order. The next valid action is shown in context.</p></div><button className="secondary self-start" type="button" onClick={()=>void refresh()} disabled={loading||!selectedId}>{loading?'Loading…':'Refresh floor'}</button></div>
    {message&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status">{message}</div>}
    {error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}
    <div className="mt-5 panel p-4"><label className="muted text-xs font-bold uppercase tracking-[.12em]" htmlFor="floor-order">Repair order</label><select id="floor-order" className="mt-2 w-full" value={selectedId??''} onChange={e=>setSelectedId(e.target.value||null)}>{activeOrders.map(o=><option key={o.id} value={o.id}>{o.repair_order_number} · {o.customer_concern?.trim()||'Service'} · {human(o.status)}</option>)}</select></div>
    {floor&&<><div className="mt-4 grid gap-3 sm:grid-cols-4"><div className="stat"><p className="muted text-xs uppercase tracking-[.12em]">Inspection</p><p className="mt-2 text-2xl font-black">{floor.summary.submittedInspections?'Submitted':activeInspection?'In progress':'Not started'}</p></div><div className="stat"><p className="muted text-xs uppercase tracking-[.12em]">Urgent findings</p><p className="mt-2 text-3xl font-black text-amber-300">{floor.summary.urgentFindings}</p></div><div className="stat"><p className="muted text-xs uppercase tracking-[.12em]">Open work</p><p className="mt-2 text-3xl font-black">{floor.summary.openWorkItems}</p></div><div className="stat"><p className="muted text-xs uppercase tracking-[.12em]">Technician time</p><p className="mt-2 text-3xl font-black">{floor.summary.laborMinutes}m</p><p className="muted mt-1 text-xs">{floor.summary.activeClocks} running</p></div></div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2"><section className="panel p-5"><div className="flex items-start justify-between gap-3"><div><p className="kicker">DVI</p><h3 className="mt-1 text-xl font-bold">Digital vehicle inspection</h3><p className="muted mt-1 text-sm">Record what the technician sees before approval or repair decisions.</p></div>{!activeInspection&&!submittedInspection&&<button className="primary" type="button" disabled={busy==='dvi-start'} onClick={()=>void startDvi()}>{busy==='dvi-start'?'Starting…':'Start inspection'}</button>}</div>
        {activeInspection&&<div className="mt-4 space-y-3"><div className="rounded-xl border border-white/10 bg-white/[.03] p-3"><p className="text-sm font-bold">Inspection in progress</p><p className="muted mt-1 text-xs">{floor.findings.filter(f=>f.inspection_id===activeInspection.id).length} findings recorded</p></div><div className="grid gap-2 sm:grid-cols-3"><input value={section} onChange={e=>setSection(e.target.value)} placeholder="Section"/><input className="sm:col-span-2" value={item} onChange={e=>setItem(e.target.value)} placeholder="Finding, e.g. front brake pads"/></div><div className="flex flex-col gap-2 sm:flex-row"><select value={severity} onChange={e=>setSeverity(e.target.value as Finding['severity'])}><option value="good">Good</option><option value="attention">Needs attention</option><option value="urgent">Urgent</option><option value="not_inspected">Not inspected</option></select><button className="secondary" type="button" disabled={!item.trim()||busy==='dvi-finding'} onClick={()=>void addFinding()}>{busy==='dvi-finding'?'Saving…':'Save finding'}</button><button className="primary" type="button" disabled={floor.findings.filter(f=>f.inspection_id===activeInspection.id).length===0||busy==='dvi-submit'} onClick={()=>void submitDvi()}>{busy==='dvi-submit'?'Submitting…':'Submit inspection'}</button></div></div>}
        {submittedInspection&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-4"><p className="font-bold">Inspection submitted</p><p className="muted mt-1 text-sm">{floor.findings.filter(f=>f.inspection_id===submittedInspection.id).length} findings are part of the repair record.</p></div>}
        {floor.findings.length>0&&<div className="mt-4 space-y-2">{floor.findings.slice(-8).reverse().map(f=><div key={f.id} className="flex items-start justify-between gap-3 border-b border-white/10 py-2 last:border-0"><div><p className="text-sm font-semibold">{f.item}</p><p className="muted text-xs">{f.section}</p></div><span className="rounded-full border border-white/10 px-2 py-1 text-[11px] font-bold uppercase tracking-[.08em]">{human(f.severity)}</span></div>)}</div>}
      </section>
      <section className="panel p-5"><div><p className="kicker">Technician work</p><h3 className="mt-1 text-xl font-bold">Work in progress</h3><p className="muted mt-1 text-sm">Assigned jobs, blockers, technician time and QC are managed here.</p></div><div className="mt-4 space-y-3">{floor.workItems.length===0?<div className="rounded-xl border border-white/10 p-4"><p className="font-semibold">No work items yet</p><p className="muted mt-1 text-sm">Approved repair lines can be converted into technician work items.</p></div>:floor.workItems.map(w=>{const next=workNext(w);const clock=floor.timeEntries.find(t=>t.work_item_id===w.id&&!t.ended_at);return <article key={w.id} className="rounded-xl border border-white/10 bg-white/[.03] p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{w.title}</p><p className="muted mt-1 text-xs">{human(w.status)}{w.blocked_reason?` · ${w.blocked_reason}`:''}</p></div>{w.estimated_minutes!=null&&<span className="muted text-xs">{w.estimated_minutes}m est.</span>}</div><div className="mt-3 flex flex-wrap gap-2">{next&&<button className="primary" type="button" disabled={busy===`work-${w.id}`} onClick={()=>void updateWork(w,next.action)}>{busy===`work-${w.id}`?'Updating…':next.label}</button>}{w.status==='in_progress'&&<><button className="secondary" type="button" disabled={busy===`work-${w.id}`} onClick={()=>void updateWork(w,'wait_parts')}>Waiting for parts</button><button className="secondary" type="button" disabled={busy===`work-${w.id}`} onClick={()=>void updateWork(w,'wait_customer')}>Waiting for customer</button></>}{w.technician_actor_id&&(clock?<button className="secondary" type="button" disabled={busy===`clock-${w.id}`} onClick={()=>void clockOut(w)}>Stop time</button>:['assigned','in_progress','paused'].includes(w.status)&&<button className="secondary" type="button" disabled={busy===`clock-${w.id}`} onClick={()=>void clockIn(w)}>Start time</button>)}</div></article>})}</div></section></div>
    </>}
  </section>
}
