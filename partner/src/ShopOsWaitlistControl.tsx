import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';

type WaitlistEntry={
  id:string;
  state:'waiting'|'offered'|'booked'|'expired'|'cancelled';
  requested_service_category?:string|null;
  requested_after?:string|null;
  requested_before?:string|null;
  estimated_duration_minutes?:number|null;
  preferred_resource_types?:string[];
  priority?:number;
  notes?:string|null;
  offer_expires_at?:string|null;
  appointment_id?:string|null;
};

function human(value:string|null|undefined){return value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'General service'}
function when(value:string|null|undefined){return value?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'Flexible'}
function actionError(error:unknown){const code=error instanceof Error?error.message:'request failed';return `${human(code)}. Refresh the waitlist and try again.`}

export function ShopOsWaitlistControl(){
  const[entries,setEntries]=useState<WaitlistEntry[]>([]);
  const[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState<string|null>(null);
  const[message,setMessage]=useState<string|null>(null);
  const[error,setError]=useState<string|null>(null);
  const[appointmentValue,setAppointmentValue]=useState<Record<string,string>>({});
  const requestSequence=useRef(0);

  const load=useCallback(async()=>{
    const requestId=++requestSequence.current;
    setLoading(true);setError(null);
    try{
      const response=await api.get<{entries:WaitlistEntry[]}>('/api/shop-os/waitlist');
      if(requestId!==requestSequence.current)return;
      setEntries(response.entries??[]);
    }catch(e){
      if(requestId!==requestSequence.current)return;
      setError(`Waitlist could not load. ${actionError(e)}`);
    }finally{
      if(requestId===requestSequence.current)setLoading(false);
    }
  },[]);

  useEffect(()=>{void load()},[load]);

  const ordered=useMemo(()=>[...entries].sort((a,b)=>{
    const rank:Record<string,number>={offered:0,waiting:1,expired:2,booked:3,cancelled:4};
    return (rank[a.state]??9)-(rank[b.state]??9)||(b.priority??0)-(a.priority??0);
  }),[entries]);

  async function act(entry:WaitlistEntry,action:'offer'|'book'|'cancel'|'expire'|'requeue'){
    if(action==='book'&&!appointmentValue[entry.id]?.trim()){
      setError('Choose the appointment created for this customer before marking the waitlist entry booked.');
      return;
    }
    setBusy(entry.id);setError(null);setMessage(null);
    try{
      const body:Record<string,unknown>={action};
      if(action==='offer') body.offerExpiresAt=new Date(Date.now()+30*60_000).toISOString();
      if(action==='book') body.appointmentId=appointmentValue[entry.id].trim();
      await api.patch(`/api/shop-os/waitlist/${entry.id}`,body);
      const labels={offer:'Slot offered for 30 minutes.',book:'Waitlist work linked to its appointment.',cancel:'Waitlist request cancelled.',expire:'Offer expired and released for recovery.',requeue:'Work returned to the waiting queue.'};
      setMessage(labels[action]);
      await load();
    }catch(e){setError(`Waitlist was not updated. ${actionError(e)}`)}finally{setBusy(null)}
  }

  return <section className="mt-8" aria-labelledby="shop-os-waitlist-heading">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div><p className="kicker">Overflow recovery</p><h2 id="shop-os-waitlist-heading" className="mt-1 text-2xl font-bold">Waitlist</h2><p className="muted mt-1 max-w-2xl text-sm">Offer recovered capacity, requeue expired work, and explicitly link booked overflow to its appointment.</p></div>
      <button className="secondary self-start" type="button" disabled={loading} onClick={()=>void load()}>{loading?'Refreshing…':'Refresh waitlist'}</button>
    </div>
    {message&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status" aria-live="polite">{message}</div>}
    {error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}
    <div className="mt-5 space-y-3">
      {!loading&&ordered.length===0&&<div className="panel p-6"><p className="font-semibold">No overflow work waiting</p><p className="muted mt-1 text-sm">When demand exceeds verified capacity, recoverable work will appear here.</p></div>}
      {ordered.map(entry=><article key={entry.id} className="panel p-4">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-white/10 bg-white/[.04] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[.1em]">{human(entry.state)}</span>{entry.priority!==undefined&&<span className="muted text-xs">Priority {entry.priority}</span>}</div><h3 className="mt-2 font-bold">{human(entry.requested_service_category)}</h3><p className="muted mt-1 text-sm">Window: {when(entry.requested_after)}{entry.requested_before?` → ${when(entry.requested_before)}`:''}</p>{entry.estimated_duration_minutes&&<p className="muted mt-1 text-xs">Estimated {entry.estimated_duration_minutes} minutes</p>}{entry.preferred_resource_types?.length?<p className="muted mt-1 text-xs">Needs: {entry.preferred_resource_types.map(human).join(', ')}</p>:null}{entry.state==='offered'&&entry.offer_expires_at&&<p className="mt-2 text-xs text-amber-100">Offer expires {when(entry.offer_expires_at)}</p>}</div>
          <div className="flex min-w-[15rem] flex-col gap-2">
            {entry.state==='waiting'&&<button className="primary" type="button" disabled={busy===entry.id} onClick={()=>void act(entry,'offer')}>{busy===entry.id?'Updating…':'Offer recovered slot'}</button>}
            {entry.state==='offered'&&<><label className="text-xs"><span className="muted">Created appointment ID</span><input className="input mt-1 w-full" value={appointmentValue[entry.id]??''} onChange={e=>setAppointmentValue(current=>({...current,[entry.id]:e.target.value}))} placeholder="Appointment UUID"/></label><button className="primary" type="button" disabled={busy===entry.id} onClick={()=>void act(entry,'book')}>Mark booked</button><button className="secondary" type="button" disabled={busy===entry.id} onClick={()=>void act(entry,'expire')}>Expire offer</button></>}
            {entry.state==='expired'&&<button className="primary" type="button" disabled={busy===entry.id} onClick={()=>void act(entry,'requeue')}>Return to waitlist</button>}
            {['waiting','offered','expired'].includes(entry.state)&&<button className="secondary" type="button" disabled={busy===entry.id} onClick={()=>void act(entry,'cancel')}>Cancel request</button>}
            {entry.state==='booked'&&<p className="muted text-xs">Booked{entry.appointment_id?` · ${entry.appointment_id}`:''}. Continue from the day schedule.</p>}
          </div>
        </div>
      </article>)}
    </div>
  </section>;
}
