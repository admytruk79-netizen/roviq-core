import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';

type Appointment={
  id:string;
  resource_id:string|null;
  service_case_id?:string|null;
  appointment_status:string;
  starts_at:string;
  ends_at:string;
  service_category?:string|null;
  customer_visible_summary?:string|null;
};

type Resource={
  id:string;
  resource_type:string;
  display_name:string;
  operational_state?:'available'|'busy'|'blocked'|'offline';
  active?:boolean;
};

type Board={resources:Resource[];appointments:Appointment[]};
type ResourceResponse={resources:Resource[]};
type RangeMode='day'|'week';

function human(value:string|null|undefined){
  return value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'—';
}

function statusLabel(status:string){
  const labels:Record<string,string>={
    held:'Arrival expected',
    confirmed:'Checked in — ready to start',
    in_progress:'Work in progress',
    completed:'Work complete',
    cancelled:'Cancelled',
    no_show:'No show',
    released:'Released'
  };
  return labels[status]??human(status);
}

function nextAction(status:string){
  if(status==='held')return 'Check in vehicle or mark no-show after the scheduled start';
  if(status==='confirmed')return 'Start work';
  if(status==='in_progress')return 'Complete work';
  if(status==='cancelled')return 'Reschedule if customer still needs service';
  if(status==='no_show')return 'Reschedule when customer confirms';
  return 'No action required';
}

function formatDateTime(value:string){
  return new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value));
}

export function rangeFor(mode:RangeMode,now=new Date()){
  const from=new Date(now);
  from.setHours(0,0,0,0);
  const to=new Date(from);
  to.setDate(to.getDate()+(mode==='day'?1:7));
  return{from:from.toISOString(),to:to.toISOString()};
}

export function isAppointmentActiveNow(appointment:Appointment,nowMs=Date.now()){
  if(!['held','confirmed','in_progress'].includes(appointment.appointment_status))return false;
  const startsAt=new Date(appointment.starts_at).getTime();
  const endsAt=new Date(appointment.ends_at).getTime();
  return Number.isFinite(startsAt)&&Number.isFinite(endsAt)&&startsAt<=nowMs&&endsAt>nowMs;
}

function toLocalInput(value:string){
  const d=new Date(value);
  const offset=d.getTimezoneOffset()*60_000;
  return new Date(d.getTime()-offset).toISOString().slice(0,16);
}

function fromLocalInput(value:string){
  return new Date(value).toISOString();
}

export function ShopOsScheduleControl(){
  const[mode,setMode]=useState<RangeMode>('day');
  const[board,setBoard]=useState<Board|null>(null);
  const[resources,setResources]=useState<Resource[]>([]);
  const[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState<string|null>(null);
  const[error,setError]=useState<string|null>(null);
  const[message,setMessage]=useState<string|null>(null);
  const[editing,setEditing]=useState<Appointment|null>(null);
  const[startValue,setStartValue]=useState('');
  const[endValue,setEndValue]=useState('');
  const[resourceValue,setResourceValue]=useState('');
  const[clockMs,setClockMs]=useState(()=>Date.now());
  const requestSequence=useRef(0);

  const load=useCallback(async()=>{
    const requestId=++requestSequence.current;
    const range=rangeFor(mode);
    setLoading(true);
    setError(null);
    try{
      const[b,r]=await Promise.all([
        api.get<Board>(`/api/shop-os/board?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
        api.get<ResourceResponse>('/api/shop-os/resources')
      ]);
      if(requestId!==requestSequence.current)return;
      setBoard(b);
      setResources(r.resources??[]);
    }catch(e){
      if(requestId!==requestSequence.current)return;
      setError(`Schedule could not load. ${human(e instanceof Error?e.message:'Request failed')}. Refresh and try again.`);
    }finally{
      if(requestId===requestSequence.current)setLoading(false);
    }
  },[mode]);

  useEffect(()=>{void load()},[load]);
  useEffect(()=>{
    const timer=window.setInterval(()=>setClockMs(Date.now()),30_000);
    return()=>window.clearInterval(timer);
  },[]);

  const resourceNames=useMemo(()=>new Map(resources.map(r=>[r.id,r.display_name])),[resources]);
  const appointments=useMemo(()=>[...(board?.appointments??[])].sort((a,b)=>new Date(a.starts_at).getTime()-new Date(b.starts_at).getTime()),[board]);
  const active=appointments.filter(a=>isAppointmentActiveNow(a,clockMs));
  const exceptions=appointments.filter(a=>['cancelled','no_show'].includes(a.appointment_status));

  function openReschedule(appointment:Appointment){
    setEditing(appointment);
    setStartValue(toLocalInput(appointment.starts_at));
    setEndValue(toLocalInput(appointment.ends_at));
    setResourceValue(appointment.resource_id??'');
    setError(null);
    setMessage(null);
  }

  async function reschedule(){
    if(!editing)return;
    if(!startValue||!endValue){setError('Choose both a new start and end time before rescheduling.');return;}
    const startsAt=fromLocalInput(startValue),endsAt=fromLocalInput(endValue);
    if(new Date(endsAt).getTime()<=new Date(startsAt).getTime()){
      setError('End time must be after start time.');
      return;
    }
    setBusy(editing.id);setError(null);setMessage(null);
    try{
      await api.patch(`/api/shop-os/appointments/${editing.id}`,{
        action:'reschedule',startsAt,endsAt,...(resourceValue?{resourceId:resourceValue}:{})
      });
      setMessage('Appointment rescheduled. Capacity and resource conflicts were rechecked before saving.');
      setEditing(null);
      await load();
    }catch(e){
      setError(`Appointment was not rescheduled. ${human(e instanceof Error?e.message:'Request failed')}. Choose another time/resource or refresh capacity.`);
    }finally{setBusy(null)}
  }

  async function appointmentAction(appointment:Appointment,action:'cancel'|'no_show'){
    setBusy(appointment.id);setError(null);setMessage(null);
    try{
      await api.patch(`/api/shop-os/appointments/${appointment.id}`,{action,reason:action==='cancel'?'Cancelled from Shop OS schedule':'Customer did not arrive'});
      setMessage(action==='cancel'?'Appointment cancelled. The slot is available for recovery/rescheduling.':'Appointment marked no-show. Reschedule when the customer confirms a new time.');
      await load();
    }catch(e){
      setError(`Appointment could not be updated. ${human(e instanceof Error?e.message:'Request failed')}. Refresh the schedule and try again.`);
    }finally{setBusy(null)}
  }

  async function resourceState(resource:Resource,operationalState:'available'|'busy'|'blocked'|'offline'){
    setBusy(resource.id);setError(null);setMessage(null);
    try{
      await api.patch(`/api/shop-os/resources/${resource.id}`,{operationalState});
      setMessage(`${resource.display_name} is now ${human(operationalState).toLowerCase()}. Routing and scheduling will respect this state.`);
      await load();
    }catch(e){
      setError(`Resource state was not changed. ${human(e instanceof Error?e.message:'Request failed')}. Refresh and try again.`);
    }finally{setBusy(null)}
  }

  return <section className="mt-8" id="shop-os-schedule-control" aria-labelledby="shop-os-schedule-heading">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        <p className="kicker">Scheduling control</p>
        <h2 id="shop-os-schedule-heading" className="mt-1 text-2xl font-bold">Day / week schedule</h2>
        <p className="muted mt-1 max-w-2xl text-sm">See current status, next action and assigned resource. Conflicts are blocked before a schedule change is saved.</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Schedule range">
        <button type="button" className={mode==='day'?'primary':'secondary'} aria-pressed={mode==='day'} onClick={()=>setMode('day')}>Today</button>
        <button type="button" className={mode==='week'?'primary':'secondary'} aria-pressed={mode==='week'} onClick={()=>setMode('week')}>7 days</button>
        <button type="button" className="secondary" disabled={loading} onClick={()=>void load()}>{loading?'Refreshing…':'Refresh'}</button>
      </div>
    </div>

    {message&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status" aria-live="polite">{message}</div>}
    {error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}

    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      <div className="stat"><p className="muted text-xs uppercase tracking-[.12em]">Scheduled</p><p className="mt-2 text-3xl font-black">{appointments.length}</p><p className="muted mt-1 text-xs">in selected range</p></div>
      <div className="stat"><p className="muted text-xs uppercase tracking-[.12em]">Active now</p><p className="mt-2 text-3xl font-black text-[var(--green)]">{active.length}</p><p className="muted mt-1 text-xs">happening at this moment</p></div>
      <div className="stat"><p className="muted text-xs uppercase tracking-[.12em]">Needs recovery</p><p className="mt-2 text-3xl font-black text-amber-300">{exceptions.length}</p><p className="muted mt-1 text-xs">cancelled / no-show</p></div>
    </div>

    <div className="mt-6 grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
      <div className="space-y-3">
        {!loading&&appointments.length===0&&<div className="panel p-6"><p className="font-semibold">No scheduled work in this range</p><p className="muted mt-1 text-sm">Create or reschedule an appointment when service capacity is available.</p></div>}
        {appointments.map(a=><article key={a.id} className="panel p-4">
          <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-white/10 bg-white/[.04] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[.1em]">{statusLabel(a.appointment_status)}</span>
                <span className="muted text-xs">{formatDateTime(a.starts_at)} – {formatDateTime(a.ends_at)}</span>
              </div>
              <h3 className="mt-2 font-bold">{a.customer_visible_summary?.trim()||human(a.service_category)||'Service appointment'}</h3>
              <p className="muted mt-1 text-sm">Resource: {a.resource_id?resourceNames.get(a.resource_id)??'Assigned resource':'Not assigned'}</p>
              <p className="mt-1 text-xs text-amber-100">Next: {nextAction(a.appointment_status)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {['held','confirmed'].includes(a.appointment_status)&&<button className="secondary" type="button" disabled={busy===a.id} onClick={()=>openReschedule(a)}>Reschedule</button>}
              {['held','confirmed'].includes(a.appointment_status)&&<button className="secondary" type="button" disabled={busy===a.id} onClick={()=>void appointmentAction(a,'cancel')}>Cancel</button>}
              {a.appointment_status==='held'&&new Date(a.starts_at).getTime()<=clockMs&&<button className="secondary" type="button" disabled={busy===a.id} onClick={()=>void appointmentAction(a,'no_show')}>No show</button>}
            </div>
          </div>
        </article>)}
      </div>

      <aside className="panel p-5" aria-labelledby="resource-control-heading">
        <p className="kicker">Resource control</p>
        <h3 id="resource-control-heading" className="mt-1 text-lg font-bold">Bays, technicians & resources</h3>
        <p className="muted mt-1 text-xs">Blocking a resource immediately prevents it from being treated as schedulable.</p>
        <div className="mt-4 space-y-3">
          {resources.length===0?<p className="muted text-sm">No Shop OS resources configured.</p>:resources.map(r=><div key={r.id} className="rounded-xl border border-white/10 bg-white/[.02] p-3">
            <div className="flex items-center justify-between gap-3"><div><p className="font-semibold">{r.display_name}</p><p className="muted text-xs">{human(r.resource_type)}</p></div><span className="text-xs font-bold">{human(r.operational_state??'available')}</span></div>
            <label className="mt-3 block text-xs"><span className="muted">Operational state</span><select className="input mt-1 w-full" value={r.operational_state??'available'} disabled={busy===r.id} onChange={e=>void resourceState(r,e.target.value as 'available'|'busy'|'blocked'|'offline')}><option value="available">Available</option><option value="busy">Busy</option><option value="blocked">Blocked</option><option value="offline">Offline</option></select></label>
          </div>)}
        </div>
      </aside>
    </div>

    {editing&&<div className="mt-5 panel p-5" role="region" aria-labelledby="reschedule-heading">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><p className="kicker">Recovery</p><h3 id="reschedule-heading" className="mt-1 text-lg font-bold">Reschedule appointment</h3><p className="muted mt-1 text-sm">Capacity and resource conflicts will be checked before the change is accepted.</p></div><button className="secondary" type="button" onClick={()=>setEditing(null)}>Close</button></div>
      <div className="mt-4 grid gap-3 md:grid-cols-3"><label className="text-sm"><span className="muted">Start</span><input className="input mt-1 w-full" type="datetime-local" value={startValue} onChange={e=>setStartValue(e.target.value)}/></label><label className="text-sm"><span className="muted">End</span><input className="input mt-1 w-full" type="datetime-local" value={endValue} onChange={e=>setEndValue(e.target.value)}/></label><label className="text-sm"><span className="muted">Resource</span><select className="input mt-1 w-full" value={resourceValue} onChange={e=>setResourceValue(e.target.value)}><option value="">Keep current resource</option>{resources.filter(r=>r.active!==false&&!['blocked','offline'].includes(r.operational_state??'available')).map(r=><option key={r.id} value={r.id}>{r.display_name} · {human(r.resource_type)}</option>)}</select></label></div>
      <div className="mt-4 flex flex-wrap gap-2"><button className="primary" type="button" disabled={busy===editing.id} onClick={()=>void reschedule()}>{busy===editing.id?'Checking capacity…':'Save new time'}</button><button className="secondary" type="button" onClick={()=>setEditing(null)}>Cancel change</button></div>
    </div>}
  </section>;
}
