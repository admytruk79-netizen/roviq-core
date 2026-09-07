import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';

type RepairOrder={id:string;repair_order_number:string;status:string;customer_concern?:string|null;updated_at:string};
type Inspection={id:string;status:string;inspection_type:string};
type Finding={id:string;inspection_id:string;section:string;item:string;severity:'good'|'attention'|'urgent'|'not_inspected'};
type Floor={inspections:Inspection[];findings:Finding[]};

function human(value:string|null|undefined){return value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'—'}
function activeOrder(order:RepairOrder){return !['closed','cancelled'].includes(order.status)}

export function ShopOsDviControl(){
  const[orders,setOrders]=useState<RepairOrder[]>([]),[selectedId,setSelectedId]=useState<string|null>(null),[floor,setFloor]=useState<Floor|null>(null),[floorOrderId,setFloorOrderId]=useState<string|null>(null),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[refreshWarning,setRefreshWarning]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[section,setSection]=useState('General'),[item,setItem]=useState(''),[severity,setSeverity]=useState<Finding['severity']>('good'),[ordersLoading,setOrdersLoading]=useState(true),[ordersLoaded,setOrdersLoaded]=useState(false);
  const selectedIdRef=useRef<string|null>(null);
  const floorRequestRef=useRef(0);
  useEffect(()=>{selectedIdRef.current=selectedId},[selectedId]);

  const activeOrders=useMemo(()=>orders.filter(activeOrder).sort((a,b)=>new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime()),[orders]);
  const floorMatchesSelection=!!selectedId&&floorOrderId===selectedId;
  const activeInspection=useMemo(()=>floorMatchesSelection?(floor?.inspections.find(i=>['draft','in_progress'].includes(i.status))??null):null,[floor,floorMatchesSelection]);
  const submitted=useMemo(()=>floorMatchesSelection?(floor?.inspections.filter(i=>i.status==='submitted').length??0):0,[floor,floorMatchesSelection]);
  const inspectionFindings=useMemo(()=>activeInspection?(floor?.findings??[]).filter(f=>f.inspection_id===activeInspection.id):[],[floor,activeInspection]);

  const loadOrders=useCallback(async()=>{
    const r=await api.get<{repairOrders:RepairOrder[]}>('/api/shop-os/repair-orders');
    setOrders(r.repairOrders);
    setSelectedId(current=>current&&r.repairOrders.some(o=>o.id===current&&activeOrder(o))?current:(r.repairOrders.find(activeOrder)?.id??null));
    setOrdersLoaded(true);
  },[]);

  const loadFloor=useCallback(async(id:string)=>{
    const requestId=++floorRequestRef.current;
    const next=await api.get<Floor>(`/api/shop-os/repair-orders/${id}/floor`);
    if(requestId!==floorRequestRef.current||selectedIdRef.current!==id)return false;
    setFloor(next);
    setFloorOrderId(id);
    return true;
  },[]);

  const retryOrders=useCallback(async()=>{
    setOrdersLoading(true);setError(null);
    try{await loadOrders()}catch(e){setError(`Could not load inspections: ${human(e instanceof Error?e.message:'request failed')}`)}finally{setOrdersLoading(false)}
  },[loadOrders]);

  useEffect(()=>{void retryOrders()},[retryOrders]);
  useEffect(()=>{
    floorRequestRef.current++;
    setFloor(null);setFloorOrderId(null);setRefreshWarning(null);
    if(!selectedId)return;
    void loadFloor(selectedId).catch(e=>{if(selectedIdRef.current===selectedId)setError(`Could not load inspection: ${human(e instanceof Error?e.message:'request failed')}`)});
  },[selectedId,loadFloor]);

  async function refreshFor(orderId:string){
    try{
      await loadOrders();
      if(selectedIdRef.current===orderId)await loadFloor(orderId);
      setRefreshWarning(null);
    }catch(e){
      setRefreshWarning(`Change saved, but the latest inspection view could not refresh: ${human(e instanceof Error?e.message:'request failed')}. Use Refresh to retry.`);
    }
  }

  async function startInspection(){
    const orderId=selectedIdRef.current;
    if(!orderId||busy)return;
    setBusy('start');setError(null);setRefreshWarning(null);setMessage(null);
    try{
      const response=await api.post<{inspection:Inspection}>(`/api/shop-os/repair-orders/${orderId}/dvi`,{inspectionType:'general'});
      if(selectedIdRef.current===orderId){
        setFloor(current=>({inspections:[...(floorOrderId===orderId&&current?current.inspections:[]),response.inspection],findings:floorOrderId===orderId&&current?current.findings:[]}));
        setFloorOrderId(orderId);
        setMessage('Inspection started.');
      }
      await refreshFor(orderId);
    }catch(e){setError(human(e instanceof Error?e.message:'request failed'))}finally{setBusy(null)}
  }

  async function saveFinding(){
    const orderId=selectedIdRef.current;
    const inspection=activeInspection;
    const draft=item.trim();
    if(!orderId||!inspection||!draft||busy)return;
    setBusy('finding');setError(null);setRefreshWarning(null);setMessage(null);
    try{
      const response=await api.post<{finding:Finding}>(`/api/shop-os/dvi/${inspection.id}/findings`,{section:section.trim()||'General',item:draft,severity});
      if(selectedIdRef.current===orderId&&floorOrderId===orderId){
        setFloor(current=>current?{...current,findings:[...current.findings,response.finding]}:current);
        setItem('');
        setMessage('Finding saved.');
      }
      await refreshFor(orderId);
    }catch(e){setError(human(e instanceof Error?e.message:'request failed'))}finally{setBusy(null)}
  }

  async function submitInspection(){
    const orderId=selectedIdRef.current;
    const inspection=activeInspection;
    if(!orderId||!inspection||busy)return;
    setBusy('submit');setError(null);setRefreshWarning(null);setMessage(null);
    try{
      const response=await api.patch<{inspection:Inspection}>(`/api/shop-os/dvi/${inspection.id}/submit`,{});
      if(selectedIdRef.current===orderId&&floorOrderId===orderId){
        setFloor(current=>current?{...current,inspections:current.inspections.map(i=>i.id===response.inspection.id?response.inspection:i)}:current);
        setMessage('Inspection submitted to the repair record.');
      }
      await refreshFor(orderId);
    }catch(e){setError(human(e instanceof Error?e.message:'request failed'))}finally{setBusy(null)}
  }

  if(ordersLoading&&!ordersLoaded)return <section className="mt-8" id="shop-os-dvi-control"><div className="panel p-5"><p className="font-semibold">Loading digital vehicle inspections…</p></div></section>;
  if(error&&!ordersLoaded)return <section className="mt-8" id="shop-os-dvi-control"><div className="panel p-5"><p className="font-bold">Digital vehicle inspections could not load</p><p className="muted mt-1 text-sm">{error}</p><button className="primary mt-4" type="button" onClick={()=>void retryOrders()}>Retry</button></div></section>;
  if(ordersLoaded&&activeOrders.length===0)return null;

  return <section className="mt-8" id="shop-os-dvi-control"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="kicker">Inspection</p><h2 className="mt-1 text-2xl font-bold">Digital vehicle inspection</h2><p className="muted mt-1 max-w-2xl text-sm">Start the DVI, record findings in plain service language, then submit it before repair decisions move forward.</p></div><button className="secondary self-start" type="button" onClick={()=>selectedId&&void loadFloor(selectedId).catch(e=>setError(`Could not refresh inspection: ${human(e instanceof Error?e.message:'request failed')}`))} disabled={!selectedId||!!busy}>Refresh</button></div>{message&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status">{message}</div>}{refreshWarning&&<div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="status">{refreshWarning}</div>}{error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}<div className="mt-5 panel p-5"><label className="muted text-xs font-bold uppercase tracking-[.12em]" htmlFor="dvi-order">Repair order</label><select id="dvi-order" className="mt-2 w-full" value={selectedId??''} disabled={!!busy} onChange={e=>setSelectedId(e.target.value||null)}>{activeOrders.map(o=><option key={o.id} value={o.id}>{o.repair_order_number} · {o.customer_concern?.trim()||'Service'} · {human(o.status)}</option>)}</select><div className="mt-4">{!floorMatchesSelection?<div className="rounded-xl border border-white/10 bg-white/[.02] p-4"><p className="font-bold">Loading selected inspection…</p></div>:!activeInspection?<div className="flex flex-col justify-between gap-3 rounded-xl border border-white/10 bg-white/[.02] p-4 sm:flex-row sm:items-center"><div><p className="font-bold">{submitted?'Previous inspection submitted':'Inspection not started'}</p><p className="muted mt-1 text-sm">{submitted?'Start a new inspection only when another technician pass is required.':'Begin the technician inspection before adding findings.'}</p></div><button className="primary" type="button" disabled={!!busy} onClick={()=>void startInspection()}>{busy==='start'?'Starting…':'Start inspection'}</button></div>:<div className="space-y-4"><div className="rounded-xl border border-white/10 bg-white/[.02] p-4"><p className="font-bold">Inspection in progress</p><p className="muted mt-1 text-sm">{inspectionFindings.length} findings recorded</p></div><div className="grid gap-2 sm:grid-cols-3"><input value={section} onChange={e=>setSection(e.target.value)} placeholder="Section"/><input className="sm:col-span-2" value={item} onChange={e=>setItem(e.target.value)} placeholder="Finding, e.g. front brake pads"/></div><div className="flex flex-col gap-2 sm:flex-row"><select value={severity} onChange={e=>setSeverity(e.target.value as Finding['severity'])}><option value="good">Good</option><option value="attention">Needs attention</option><option value="urgent">Urgent</option><option value="not_inspected">Not inspected</option></select><button className="secondary" type="button" disabled={!item.trim()||!!busy} onClick={()=>void saveFinding()}>{busy==='finding'?'Saving…':'Save finding'}</button><button className="primary" type="button" disabled={inspectionFindings.length===0||!!busy} onClick={()=>void submitInspection()}>{busy==='submit'?'Submitting…':'Submit inspection'}</button></div>{inspectionFindings.length>0&&<div className="space-y-2">{inspectionFindings.slice().reverse().map(f=><div key={f.id} className="flex items-start justify-between gap-3 border-b border-white/10 py-2 last:border-0"><div><p className="font-semibold">{f.item}</p><p className="muted text-xs">{f.section}</p></div><span className="text-xs font-bold">{human(f.severity)}</span></div>)}</div>}</div>}</div></div></section>
}
