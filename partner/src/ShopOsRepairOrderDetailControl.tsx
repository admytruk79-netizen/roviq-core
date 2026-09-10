import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';

type RepairOrder={
  id:string;repair_order_number:string;status:string;service_case_id?:string|null;appointment_id?:string|null;customer_vehicle_id?:string|null;
  advisor_actor_id?:string|null;primary_technician_actor_id?:string|null;customer_concern?:string|null;odometer?:number|null;
  subtotal_amount?:string|number;approved_amount?:string|number;tax_amount?:string|number;total_amount?:string|number;
  created_at:string;updated_at:string;approved_at?:string|null;completed_at?:string|null;closed_at?:string|null;
};
type RepairOrderLine={
  id:string;line_type:string;description:string;service_category?:string|null;quantity:string|number;unit_price:string|number;unit_cost?:string|number;
  labor_hours?:string|number|null;approval_status:string;approved_at?:string|null;declined_at?:string|null;deferred_at?:string|null;
};
type RepairOrderDetail={repairOrder:RepairOrder;lines:RepairOrderLine[]};

function human(value:string|null|undefined){return value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'—'}
function money(value:string|number|null|undefined){const amount=Number(value??0);return Number.isFinite(amount)?new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(amount):'—'}
function when(value:string|null|undefined){return value?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'—'}

export function ShopOsRepairOrderDetailControl(){
  const[orders,setOrders]=useState<RepairOrder[]>([]);
  const[selectedId,setSelectedId]=useState<string|null>(null);
  const[detail,setDetail]=useState<RepairOrderDetail|null>(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState<string|null>(null);
  const requestSequence=useRef(0);

  const loadDetail=useCallback(async(id:string)=>{
    const requestId=++requestSequence.current;
    setLoading(true);setError(null);setDetail(null);
    try{
      const response=await api.get<RepairOrderDetail>(`/api/shop-os/repair-orders/${id}`);
      if(requestId!==requestSequence.current)return;
      setDetail(response);
    }catch(e){
      if(requestId===requestSequence.current)setError(`Repair order could not load. ${human(e instanceof Error?e.message:'request failed')}. Refresh and try again.`);
    }finally{if(requestId===requestSequence.current)setLoading(false)}
  },[]);

  const refreshAll=useCallback(async(preferredId:string|null)=>{
    const requestId=++requestSequence.current;
    setLoading(true);setError(null);setDetail(null);
    try{
      const response=await api.get<{repairOrders:RepairOrder[]}>('/api/shop-os/repair-orders');
      if(requestId!==requestSequence.current)return;
      const nextOrders=response.repairOrders??[];
      const nextId=preferredId&&nextOrders.some(order=>order.id===preferredId)?preferredId:(nextOrders[0]?.id??null);
      setOrders(nextOrders);
      setSelectedId(nextId);
      if(!nextId)return;
      const nextDetail=await api.get<RepairOrderDetail>(`/api/shop-os/repair-orders/${nextId}`);
      if(requestId!==requestSequence.current)return;
      setDetail(nextDetail);
    }catch(e){
      if(requestId===requestSequence.current)setError(`Repair history could not refresh. ${human(e instanceof Error?e.message:'request failed')}. Try again.`);
    }finally{if(requestId===requestSequence.current)setLoading(false)}
  },[]);

  useEffect(()=>{void refreshAll(null)},[refreshAll]);

  function selectOrder(id:string){
    if(id===selectedId&&detail?.repairOrder.id===id)return;
    setSelectedId(id);
    void loadDetail(id);
  }

  const ordered=useMemo(()=>[...orders].sort((a,b)=>new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime()),[orders]);
  const order=detail?.repairOrder;
  const lines=detail?.lines??[];
  const approvedLines=lines.filter(line=>line.approval_status==='approved');
  const deferredLines=lines.filter(line=>['deferred','declined'].includes(line.approval_status));

  return <section className="mt-8" aria-labelledby="repair-order-detail-heading">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="kicker">Repair record</p><h2 id="repair-order-detail-heading" className="mt-1 text-2xl font-bold">Estimate, repair order & history</h2><p className="muted mt-1 max-w-2xl text-sm">Keep the customer concern, estimate decisions, technician assignment and durable service record visible without recalling a prior screen.</p></div><button className="secondary self-start" type="button" disabled={loading} onClick={()=>void refreshAll(selectedId)}>{loading?'Refreshing…':'Refresh repair history'}</button></div>
    {error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}
    <div className="mt-5 grid gap-5 xl:grid-cols-[.34fr_.66fr]"><aside className="panel p-4"><p className="muted text-xs uppercase tracking-[.12em]">Service history</p><div className="mt-3 space-y-2">{ordered.length===0?<p className="muted text-sm">No repair orders yet.</p>:ordered.slice(0,30).map(item=><button key={item.id} type="button" className={`w-full rounded-xl border px-3 py-3 text-left ${selectedId===item.id?'border-[var(--green)] bg-white/[.06]':'border-white/10 bg-white/[.02]'}`} onClick={()=>selectOrder(item.id)}><div className="flex items-center justify-between gap-2"><span className="font-bold">{item.repair_order_number}</span><span className="muted text-[11px]">{human(item.status)}</span></div><p className="muted mt-1 line-clamp-2 text-xs">{item.customer_concern?.trim()||'Service repair order'}</p><p className="muted mt-1 text-[11px]">Updated {when(item.updated_at)}</p></button>)}</div></aside><div>{loading&&!order?<div className="panel p-6" role="status" aria-live="polite"><p className="font-semibold">Loading repair record…</p><p className="muted mt-1 text-sm">The selected service history will appear when the latest record is ready.</p></div>:!order?<div className="panel p-6"><p className="font-semibold">Select a repair order</p><p className="muted mt-1 text-sm">Choose a repair record to see estimate decisions and service history.</p></div>:<div className="space-y-4"><section className="panel p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="kicker">{order.repair_order_number}</p><h3 className="mt-1 text-xl font-bold">{order.customer_concern?.trim()||'Service repair order'}</h3><p className="muted mt-1 text-xs">Opened {when(order.created_at)} · Updated {when(order.updated_at)}</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-xs font-bold">{human(order.status)}</span></div><div className="mt-4 grid gap-2 sm:grid-cols-4"><div className="stat"><p className="muted text-[11px]">Estimate</p><p className="mt-1 text-xl font-black">{money(order.subtotal_amount)}</p></div><div className="stat"><p className="muted text-[11px]">Approved</p><p className="mt-1 text-xl font-black">{money(order.approved_amount)}</p></div><div className="stat"><p className="muted text-[11px]">Total</p><p className="mt-1 text-xl font-black">{money(order.total_amount)}</p></div><div className="stat"><p className="muted text-[11px]">Odometer</p><p className="mt-1 text-xl font-black">{order.odometer??'—'}</p></div></div><div className="muted mt-4 grid gap-1 text-xs sm:grid-cols-2"><span>Service case: {order.service_case_id??'Not linked'}</span><span>Appointment: {order.appointment_id??'Not linked'}</span><span>Vehicle: {order.customer_vehicle_id??'Not linked'}</span><span>Primary technician: {order.primary_technician_actor_id??'Not assigned'}</span></div></section><section className="panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="kicker">Estimate decisions</p><h3 className="mt-1 text-lg font-bold">Repair-order lines</h3></div><span className="muted text-xs">{approvedLines.length} approved · {deferredLines.length} deferred/declined</span></div><div className="mt-3 space-y-2">{lines.length===0?<p className="muted text-sm">No estimate lines yet.</p>:lines.map(line=><article key={line.id} className="rounded-xl border border-white/10 bg-white/[.02] p-3"><div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start"><div><div className="flex flex-wrap items-center gap-2"><span className="font-bold">{line.description}</span><span className="muted text-[11px]">{human(line.line_type)}</span></div><p className="muted mt-1 text-xs">{Number(line.quantity)} × {money(line.unit_price)}{line.labor_hours!=null?` · ${Number(line.labor_hours)} labor h`:''}</p></div><div className="text-right"><p className="font-bold">{money(Number(line.quantity)*Number(line.unit_price))}</p><p className={`text-xs ${['deferred','declined'].includes(line.approval_status)?'text-amber-200':'muted'}`}>{human(line.approval_status)}</p></div></div></article>)}</div></section><section className="panel p-5"><p className="kicker">Timeline anchors</p><h3 className="mt-1 text-lg font-bold">Record continuity</h3><div className="muted mt-3 grid gap-2 text-sm sm:grid-cols-2"><span>Approved: {when(order.approved_at)}</span><span>Completed: {when(order.completed_at)}</span><span>Closed: {when(order.closed_at)}</span><span>Last updated: {when(order.updated_at)}</span></div></section></div>}</div></div>
  </section>;
}
