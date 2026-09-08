import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';
import {defaultRecoveryWindow,isRecoverableAppointment,replacementAppointmentBody,type RecoverableAppointment} from './shop-os-recovery-model';

type Resource={id:string;resource_type:string;display_name:string;operational_state?:'available'|'busy'|'blocked'|'offline';active?:boolean};
type Board={appointments:RecoverableAppointment[]};
type ResourceResponse={resources:Resource[]};

function human(value:string|null|undefined){return value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'General service'}
function when(value:string){return new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value))}
function toLocalInput(value:string){const d=new Date(value);const offset=d.getTimezoneOffset()*60_000;return new Date(d.getTime()-offset).toISOString().slice(0,16)}
function fromLocalInput(value:string){return new Date(value).toISOString()}
function recoveryRange(){const from=new Date();from.setHours(0,0,0,0);from.setDate(from.getDate()-7);const to=new Date();to.setHours(23,59,59,999);to.setDate(to.getDate()+7);return{from:from.toISOString(),to:to.toISOString()}}

export function ShopOsRecoveryControl(){
  const[appointments,setAppointments]=useState<RecoverableAppointment[]>([]);
  const[resources,setResources]=useState<Resource[]>([]);
  const[loading,setLoading]=useState(true);
  const[pending,setPending]=useState<Set<string>>(()=>new Set());
  const[editing,setEditing]=useState<RecoverableAppointment|null>(null);
  const[startValue,setStartValue]=useState('');
  const[endValue,setEndValue]=useState('');
  const[resourceValue,setResourceValue]=useState('');
  const[message,setMessage]=useState<string|null>(null);
  const[error,setError]=useState<string|null>(null);
  const requestSequence=useRef(0);

  const load=useCallback(async()=>{
    const requestId=++requestSequence.current;
    const range=recoveryRange();
    setLoading(true);setError(null);
    try{
      const[b,r]=await Promise.all([
        api.get<Board>(`/api/shop-os/board?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
        api.get<ResourceResponse>('/api/shop-os/resources')
      ]);
      if(requestId!==requestSequence.current)return;
      setAppointments((b.appointments??[]).filter(isRecoverableAppointment));
      setResources(r.resources??[]);
    }catch(e){
      if(requestId!==requestSequence.current)return;
      setError(`Recovery queue could not load. ${human(e instanceof Error?e.message:'request failed')}. Refresh and try again.`);
    }finally{if(requestId===requestSequence.current)setLoading(false)}
  },[]);

  useEffect(()=>{void load()},[load]);

  const availableResources=useMemo(()=>resources.filter(r=>r.active!==false&&!['blocked','offline'].includes(r.operational_state??'available')),[resources]);

  function openRecovery(appointment:RecoverableAppointment){
    if(pending.has(appointment.id))return;
    const window=defaultRecoveryWindow(appointment);
    setEditing(appointment);
    setStartValue(toLocalInput(window.startsAt));
    setEndValue(toLocalInput(window.endsAt));
    const current=availableResources.find(r=>r.id===appointment.resource_id)?.id??availableResources[0]?.id??'';
    setResourceValue(current);
    setMessage(null);setError(null);
  }

  async function createReplacement(){
    if(!editing||pending.has(editing.id))return;
    if(!resourceValue){setError('Choose an available resource before creating the replacement appointment.');return;}
    if(!startValue||!endValue){setError('Choose both a new start and end time.');return;}
    const startsAt=fromLocalInput(startValue),endsAt=fromLocalInput(endValue);
    if(new Date(startsAt).getTime()<=Date.now()){setError('Choose a future start time for the replacement appointment.');return;}
    if(new Date(endsAt).getTime()<=new Date(startsAt).getTime()){setError('End time must be after start time.');return;}
    const sourceId=editing.id;
    setPending(current=>{const next=new Set(current);next.add(sourceId);return next});setMessage(null);setError(null);
    try{
      await api.post('/api/shop-os/appointments',replacementAppointmentBody(editing,resourceValue,startsAt,endsAt));
      setMessage('Replacement appointment created. The cancelled/no-show record remains intact for audit history.');
      setEditing(null);
      await load();
    }catch(e){
      setError(`Replacement was not created. ${human(e instanceof Error?e.message:'request failed')}. Choose another time/resource or refresh verified capacity.`);
    }finally{
      setPending(current=>{const next=new Set(current);next.delete(sourceId);return next});
    }
  }

  return <section className="mt-8" aria-labelledby="shop-os-recovery-heading">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div><p className="kicker">Schedule recovery</p><h2 id="shop-os-recovery-heading" className="mt-1 text-2xl font-bold">Cancelled & no-show recovery</h2><p className="muted mt-1 max-w-2xl text-sm">Create a new capacity-checked appointment without rewriting the cancelled or no-show history.</p></div>
      <button className="secondary self-start" type="button" disabled={loading} onClick={()=>void load()}>{loading?'Refreshing…':'Refresh recovery'}</button>
    </div>
    {message&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status" aria-live="polite">{message}</div>}
    {error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}
    <div className="mt-5 space-y-3">
      {!loading&&appointments.length===0&&<div className="panel p-6"><p className="font-semibold">No appointments need recovery</p><p className="muted mt-1 text-sm">Cancelled and no-show work from the recovery window will appear here until an active replacement exists.</p></div>}
      {appointments.map(a=>{const busy=pending.has(a.id);return <article key={a.id} className="panel p-4"><div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center"><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold uppercase text-amber-200">{human(a.appointment_status)}</span><span className="muted text-xs">{when(a.starts_at)} – {when(a.ends_at)}</span></div><h3 className="mt-2 font-bold">{a.customer_visible_summary?.trim()||human(a.service_category)}</h3><p className="muted mt-1 text-xs">Original appointment {a.id}</p></div><button className="primary" type="button" disabled={busy} onClick={()=>openRecovery(a)}>{busy?'Creating replacement…':'Create replacement'}</button></div></article>})}
    </div>
    {editing&&<div className="mt-5 panel p-5" role="region" aria-labelledby="replacement-heading"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><p className="kicker">Replacement booking</p><h3 id="replacement-heading" className="mt-1 text-lg font-bold">Create a new appointment</h3><p className="muted mt-1 text-sm">The original {human(editing.appointment_status).toLowerCase()} appointment stays unchanged. New capacity is validated before booking.</p></div><button className="secondary" type="button" disabled={pending.has(editing.id)} onClick={()=>setEditing(null)}>Close</button></div><div className="mt-4 grid gap-3 md:grid-cols-3"><label className="text-sm"><span className="muted">Start</span><input className="input mt-1 w-full" disabled={pending.has(editing.id)} type="datetime-local" value={startValue} onChange={e=>setStartValue(e.target.value)}/></label><label className="text-sm"><span className="muted">End</span><input className="input mt-1 w-full" disabled={pending.has(editing.id)} type="datetime-local" value={endValue} onChange={e=>setEndValue(e.target.value)}/></label><label className="text-sm"><span className="muted">Resource</span><select className="input mt-1 w-full" disabled={pending.has(editing.id)} value={resourceValue} onChange={e=>setResourceValue(e.target.value)}><option value="">Choose resource</option>{availableResources.map(r=><option key={r.id} value={r.id}>{r.display_name} · {human(r.resource_type)}</option>)}</select></label></div><div className="mt-4 flex flex-wrap gap-2"><button className="primary" type="button" disabled={pending.has(editing.id)} onClick={()=>void createReplacement()}>{pending.has(editing.id)?'Checking capacity…':'Create replacement appointment'}</button><button className="secondary" type="button" disabled={pending.has(editing.id)} onClick={()=>setEditing(null)}>Cancel</button></div></div>}
  </section>;
}
