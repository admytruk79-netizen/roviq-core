import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
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
type LocalCustomer={id:string;display_name:string;email?:string|null;phone?:string|null};
type LocalVehicle={id:string;shop_customer_id:string;make:string;model:string;model_year?:number|null;vin?:string|null;license_plate?:string|null};
type RepairOrderDetail={repairOrder:RepairOrder;lines:RepairOrderLine[];customer?:LocalCustomer|null;vehicle?:LocalVehicle|null};
type LocalIntake={customers:LocalCustomer[];vehicles:LocalVehicle[]};

function human(value:string|null|undefined){return value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'—'}
function money(value:string|number|null|undefined){const amount=Number(value??0);return Number.isFinite(amount)?new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(amount):'—'}
function when(value:string|null|undefined){return value?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'—'}

export function ShopOsRepairOrderDetailControl(){
  const[orders,setOrders]=useState<RepairOrder[]>([]);
  const[selectedId,setSelectedId]=useState<string|null>(null);
  const[detail,setDetail]=useState<RepairOrderDetail|null>(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState<string|null>(null);
  const[message,setMessage]=useState<string|null>(null);
  const[creating,setCreating]=useState(false);
  const[concern,setConcern]=useState('');
  const[intake,setIntake]=useState<LocalIntake>({customers:[],vehicles:[]});
  const[customerId,setCustomerId]=useState('');
  const[vehicleId,setVehicleId]=useState('');
  const[customerName,setCustomerName]=useState('');
  const[existingCustomer,setExistingCustomer]=useState(false);
  const[customerEmail,setCustomerEmail]=useState('');
  const[customerPhone,setCustomerPhone]=useState('');
  const[vehicleMake,setVehicleMake]=useState('');
  const[vehicleModel,setVehicleModel]=useState('');
  const[vehicleYear,setVehicleYear]=useState('');
  const[vehicleVin,setVehicleVin]=useState('');
  const[vehiclePlate,setVehiclePlate]=useState('');
  const intakePending=useRef(false);
  const[odometer,setOdometer]=useState('');
  const[lineDescription,setLineDescription]=useState('');
  const[lineType,setLineType]=useState<'labor'|'part'|'fee'|'sublet'>('labor');
  const[lineQuantity,setLineQuantity]=useState('1');
  const[linePrice,setLinePrice]=useState('0');
  const[busy,setBusy]=useState(false);
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
      const [response,records]=await Promise.all([
        api.get<{repairOrders:RepairOrder[]}>('/api/shop-os/repair-orders'),
        api.get<LocalIntake>('/api/shop-os/local-intake')
      ]);
      if(requestId!==requestSequence.current)return;
      const nextOrders=response.repairOrders??[];
      const nextId=preferredId&&nextOrders.some(order=>order.id===preferredId)?preferredId:(nextOrders[0]?.id??null);
      setIntake(records);
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

  async function saveIntake(event:FormEvent){
    event.preventDefault();
    if(intakePending.current||busy)return;
    if((existingCustomer?!customerId:!customerName.trim())||!vehicleMake.trim()||!vehicleModel.trim())return;
    intakePending.current=true;setBusy(true);setError(null);setMessage(null);
    try{
      const vehicle={make:vehicleMake.trim(),model:vehicleModel.trim(),modelYear:vehicleYear?Number(vehicleYear):null,vin:vehicleVin.trim().toUpperCase()||null,licensePlate:vehiclePlate.trim()||null};
      if(existingCustomer){
        const result=await api.post<{vehicle:LocalVehicle}>(`/api/shop-os/customers/${customerId}/vehicles`,vehicle);
        setIntake(current=>({...current,vehicles:[...current.vehicles,result.vehicle]}));
        setVehicleId(result.vehicle.id);
      }else{
        const result=await api.post<{customer:LocalCustomer;vehicle:LocalVehicle}>('/api/shop-os/local-intake',{
          displayName:customerName.trim(),email:customerEmail.trim()||null,phone:customerPhone.trim()||null,vehicle
        });
        setIntake(current=>({customers:[...current.customers,result.customer],vehicles:[...current.vehicles,result.vehicle]}));
        setCustomerId(result.customer.id);setVehicleId(result.vehicle.id);
      }
      setCustomerName('');setCustomerEmail('');setCustomerPhone('');setVehicleMake('');setVehicleModel('');setVehicleYear('');setVehicleVin('');setVehiclePlate('');
      setMessage(existingCustomer?'Vehicle saved for the selected customer and selected for the new repair order.':'Customer and vehicle saved. They are selected for the new repair order.');
    }catch(e){setError(`Customer and vehicle were not saved: ${human(e instanceof Error?e.message:'request failed')}. Try again.`)}
    finally{intakePending.current=false;setBusy(false)}
  }

  async function createLocalOrder(event:FormEvent){
    event.preventDefault();
    const description=concern.trim();
    if(!description||busy)return;
    const miles=odometer.trim()?Number(odometer):null;
    if(miles!==null&&(!Number.isInteger(miles)||miles<0)){setError('Enter a valid nonnegative odometer reading.');return}
    setBusy(true);setError(null);setMessage(null);
    try{
      const response=await api.post<{repairOrder:RepairOrder}>('/api/shop-os/repair-orders',{customerConcern:description,odometer:miles,shopCustomerId:customerId||null,shopVehicleId:vehicleId||null});
      setConcern('');setOdometer('');setCreating(false);
      await refreshAll(response.repairOrder.id);
      setMessage(`${response.repairOrder.repair_order_number} opened as local shop work. Add estimate lines before sending it for approval.`);
    }catch(e){setError(`Could not open repair order: ${human(e instanceof Error?e.message:'request failed')}. Try again.`)}
    finally{setBusy(false)}
  }

  async function addLine(event:FormEvent){
    event.preventDefault();
    if(!order||busy)return;
    const description=lineDescription.trim(),quantity=Number(lineQuantity),unitPrice=Number(linePrice);
    if(!description||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<0){
      setError('Enter a description, a quantity above zero, and a nonnegative unit price.');return;
    }
    setBusy(true);setError(null);setMessage(null);
    try{
      await api.post(`/api/shop-os/repair-orders/${order.id}/lines`,{lineType,description,quantity,unitPrice});
      setLineDescription('');setLineQuantity('1');setLinePrice('0');
      await refreshAll(order.id);
      setMessage('Estimate line added.');
    }catch(e){setError(`Could not add estimate line: ${human(e instanceof Error?e.message:'request failed')}. Try again.`)}
    finally{setBusy(false)}
  }

  const ordered=useMemo(()=>[...orders].sort((a,b)=>new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime()),[orders]);
  const order=detail?.repairOrder;
  const lines=detail?.lines??[];
  const approvedLines=lines.filter(line=>line.approval_status==='approved');
  const deferredLines=lines.filter(line=>['deferred','declined'].includes(line.approval_status));

  return <section className="mt-8" aria-labelledby="repair-order-detail-heading">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="kicker">Repair record</p><h2 id="repair-order-detail-heading" className="mt-1 text-2xl font-bold">Estimate, repair order & history</h2><p className="muted mt-1 max-w-2xl text-sm">Keep the customer concern, estimate decisions, technician assignment and durable service record visible without recalling a prior screen.</p></div><div className="flex flex-wrap gap-2"><button className="primary" type="button" aria-expanded={creating} onClick={()=>setCreating(value=>!value)}>{creating?'Close new order':'New local repair order'}</button><button className="secondary" type="button" disabled={loading} onClick={()=>void refreshAll(selectedId)}>{loading?'Refreshing…':'Refresh repair history'}</button></div></div>
    {creating&&<form className="panel mt-4 grid gap-3 p-5" onSubmit={event=>void createLocalOrder(event)}><div><h3 className="font-bold">Open a shop repair order</h3><p className="muted mt-1 text-sm">For walk-in or direct shop work. Select a saved customer and vehicle to keep the service history connected.</p></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm"><span className="muted">Customer (optional)</span><select className="input mt-1 w-full" value={customerId} onChange={e=>{setCustomerId(e.target.value);setVehicleId('');if(!e.target.value)setExistingCustomer(false)}}><option value="">Unlinked draft</option>{intake.customers.map(c=><option key={c.id} value={c.id}>{c.display_name}{c.phone?` · ${c.phone}`:''}</option>)}</select></label><label className="text-sm"><span className="muted">Vehicle</span><select className="input mt-1 w-full" disabled={!customerId} value={vehicleId} onChange={e=>setVehicleId(e.target.value)}><option value="">Choose vehicle (optional)</option>{intake.vehicles.filter(v=>v.shop_customer_id===customerId).map(v=><option key={v.id} value={v.id}>{v.model_year??''} {v.make} {v.model}{v.license_plate?` · ${v.license_plate}`:v.vin?` · VIN …${v.vin.slice(-6)}`:''}</option>)}</select></label></div><label className="text-sm"><span className="muted">Service concern</span><textarea className="input mt-1 w-full" required maxLength={5000} value={concern} onChange={event=>setConcern(event.target.value)} placeholder="Describe the work to assess"/></label><label className="text-sm"><span className="muted">Odometer (optional)</span><input className="input mt-1 w-full" type="number" min="0" step="1" value={odometer} onChange={event=>setOdometer(event.target.value)}/></label><button className="primary justify-self-start" type="submit" disabled={busy||!concern.trim()}>{busy?'Opening…':'Open draft repair order'}</button></form>}
    {creating&&<form className="panel mt-3 grid gap-3 p-5" onSubmit={event=>void saveIntake(event)}><div><h3 className="font-bold">{existingCustomer?'Add a vehicle':'New customer & vehicle'}</h3><p className="muted mt-1 text-sm">Save a shop record, then open its repair order above.</p></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={existingCustomer} disabled={busy||!customerId} onChange={e=>setExistingCustomer(e.target.checked)}/>Add vehicle to customer selected above</label><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-3"><label className="text-sm"><span className="muted">Customer name</span><input className="input mt-1 w-full" required={!existingCustomer} disabled={existingCustomer} maxLength={200} value={customerName} onChange={e=>setCustomerName(e.target.value)}/></label><label className="text-sm"><span className="muted">Email (optional)</span><input className="input mt-1 w-full" type="email" disabled={existingCustomer} maxLength={254} value={customerEmail} onChange={e=>setCustomerEmail(e.target.value)}/></label><label className="text-sm"><span className="muted">Phone (optional)</span><input className="input mt-1 w-full" type="tel" disabled={existingCustomer} maxLength={50} value={customerPhone} onChange={e=>setCustomerPhone(e.target.value)}/></label><label className="text-sm"><span className="muted">Vehicle make</span><input className="input mt-1 w-full" required maxLength={100} value={vehicleMake} onChange={e=>setVehicleMake(e.target.value)}/></label><label className="text-sm"><span className="muted">Vehicle model</span><input className="input mt-1 w-full" required maxLength={100} value={vehicleModel} onChange={e=>setVehicleModel(e.target.value)}/></label><label className="text-sm"><span className="muted">Model year (optional)</span><input className="input mt-1 w-full" type="number" min="1886" max="2200" step="1" value={vehicleYear} onChange={e=>setVehicleYear(e.target.value)}/></label><label className="text-sm"><span className="muted">VIN (optional)</span><input className="input mt-1 w-full" minLength={17} maxLength={17} pattern="[A-HJ-NPR-Za-hj-npr-z0-9]{17}" title="Enter 17 letters and digits, excluding I, O and Q" value={vehicleVin} onChange={e=>setVehicleVin(e.target.value.toUpperCase())}/></label><label className="text-sm"><span className="muted">License plate (optional)</span><input className="input mt-1 w-full" maxLength={30} value={vehiclePlate} onChange={e=>setVehiclePlate(e.target.value)}/></label><button className="secondary self-end" type="submit">{busy?'Saving…':existingCustomer?'Save vehicle':'Save customer & vehicle'}</button></fieldset></form>}
    {message&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status">{message}</div>}
    {error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}
    <div className="mt-5 grid gap-5 xl:grid-cols-[.34fr_.66fr]"><aside className="panel p-4"><p className="muted text-xs uppercase tracking-[.12em]">Service history</p><div className="mt-3 space-y-2">{ordered.length===0?<p className="muted text-sm">No repair orders yet.</p>:ordered.slice(0,30).map(item=><button key={item.id} type="button" className={`w-full rounded-xl border px-3 py-3 text-left ${selectedId===item.id?'border-[var(--green)] bg-white/[.06]':'border-white/10 bg-white/[.02]'}`} onClick={()=>selectOrder(item.id)}><div className="flex items-center justify-between gap-2"><span className="font-bold">{item.repair_order_number}</span><span className="muted text-[11px]">{human(item.status)}</span></div><p className="muted mt-1 line-clamp-2 text-xs">{item.customer_concern?.trim()||'Service repair order'}</p><p className="muted mt-1 text-[11px]">Updated {when(item.updated_at)}</p></button>)}</div></aside><div>{loading&&!order?<div className="panel p-6" role="status" aria-live="polite"><p className="font-semibold">Loading repair record…</p><p className="muted mt-1 text-sm">The selected service history will appear when the latest record is ready.</p></div>:!order?<div className="panel p-6"><p className="font-semibold">Select a repair order</p><p className="muted mt-1 text-sm">Choose a repair record to see estimate decisions and service history.</p></div>:<div className="space-y-4"><section className="panel p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="kicker">{order.repair_order_number}</p><h3 className="mt-1 text-xl font-bold">{order.customer_concern?.trim()||'Service repair order'}</h3><p className="muted mt-1 text-xs">Opened {when(order.created_at)} · Updated {when(order.updated_at)}</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-xs font-bold">{human(order.status)}</span></div><div className="mt-4 grid gap-2 sm:grid-cols-4"><div className="stat"><p className="muted text-[11px]">Estimate</p><p className="mt-1 text-xl font-black">{money(order.subtotal_amount)}</p></div><div className="stat"><p className="muted text-[11px]">Approved</p><p className="mt-1 text-xl font-black">{money(order.approved_amount)}</p></div><div className="stat"><p className="muted text-[11px]">Total</p><p className="mt-1 text-xl font-black">{money(order.total_amount)}</p></div><div className="stat"><p className="muted text-[11px]">Odometer</p><p className="mt-1 text-xl font-black">{order.odometer??'—'}</p></div></div><div className="muted mt-4 grid gap-1 text-xs sm:grid-cols-2"><span>Service case: {order.service_case_id??'Not linked'}</span><span>Appointment: {order.appointment_id??'Not linked'}</span><span>Customer: {detail?.customer?.display_name??'Not linked'}</span><span>Vehicle: {detail?.vehicle?`${detail.vehicle.model_year??''} ${detail.vehicle.make} ${detail.vehicle.model}${detail.vehicle.license_plate?` · ${detail.vehicle.license_plate}`:''}`:order.customer_vehicle_id??'Not linked'}</span><span>Primary technician: {order.primary_technician_actor_id??'Not assigned'}</span></div></section><section className="panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="kicker">Estimate decisions</p><h3 className="mt-1 text-lg font-bold">Repair-order lines</h3></div><span className="muted text-xs">{approvedLines.length} approved · {deferredLines.length} deferred/declined</span></div>{['draft','estimate_pending'].includes(order.status)&&<form className="mt-4 grid gap-2 rounded-xl border border-white/10 p-3 sm:grid-cols-[.8fr_2fr_.5fr_.7fr_auto]" onSubmit={event=>void addLine(event)}><label className="text-xs"><span className="muted">Type</span><select className="input mt-1 w-full" value={lineType} onChange={event=>setLineType(event.target.value as typeof lineType)}><option value="labor">Labor</option><option value="part">Part</option><option value="fee">Fee</option><option value="sublet">Sublet</option></select></label><label className="text-xs"><span className="muted">Description</span><input className="input mt-1 w-full" required maxLength={5000} value={lineDescription} onChange={event=>setLineDescription(event.target.value)}/></label><label className="text-xs"><span className="muted">Qty</span><input className="input mt-1 w-full" type="number" min="0.001" step="any" required value={lineQuantity} onChange={event=>setLineQuantity(event.target.value)}/></label><label className="text-xs"><span className="muted">Unit price</span><input className="input mt-1 w-full" type="number" min="0" step="0.01" required value={linePrice} onChange={event=>setLinePrice(event.target.value)}/></label><button className="secondary self-end" type="submit" disabled={busy||!lineDescription.trim()}>{busy?'Saving…':'Add line'}</button></form>}<div className="mt-3 space-y-2">{lines.length===0?<p className="muted text-sm">No estimate lines yet.</p>:lines.map(line=><article key={line.id} className="rounded-xl border border-white/10 bg-white/[.02] p-3"><div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start"><div><div className="flex flex-wrap items-center gap-2"><span className="font-bold">{line.description}</span><span className="muted text-[11px]">{human(line.line_type)}</span></div><p className="muted mt-1 text-xs">{Number(line.quantity)} × {money(line.unit_price)}{line.labor_hours!=null?` · ${Number(line.labor_hours)} labor h`:''}</p></div><div className="text-right"><p className="font-bold">{money(Number(line.quantity)*Number(line.unit_price))}</p><p className={`text-xs ${['deferred','declined'].includes(line.approval_status)?'text-amber-200':'muted'}`}>{human(line.approval_status)}</p></div></div></article>)}</div></section><section className="panel p-5"><p className="kicker">Timeline anchors</p><h3 className="mt-1 text-lg font-bold">Record continuity</h3><div className="muted mt-3 grid gap-2 text-sm sm:grid-cols-2"><span>Approved: {when(order.approved_at)}</span><span>Completed: {when(order.completed_at)}</span><span>Closed: {when(order.closed_at)}</span><span>Last updated: {when(order.updated_at)}</span></div></section></div>}</div></div>
  </section>;
}
