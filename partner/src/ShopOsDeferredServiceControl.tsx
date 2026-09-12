import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';
import {deferredPrimaryAction,eligibleDeferredAppointments,type DeferredAppointment,type DeferredServiceItem} from './shop-os-deferred-model';

type AppointmentChoices={appointments:DeferredAppointment[]};

function human(value:string|null|undefined){return value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'—'}
function when(value:string|null|undefined){return value?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'Not scheduled'}
function money(value:string|number|null|undefined){const amount=Number(value??0);return Number.isFinite(amount)?new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(amount):'—'}
function selectedAppointmentStillEligible(selectedId:string|undefined,choices:DeferredAppointment[]){return !!selectedId&&choices.some(a=>a.id===selectedId)}

export function ShopOsDeferredServiceControl(){
  const[items,setItems]=useState<DeferredServiceItem[]>([]);
  const[appointments,setAppointments]=useState<DeferredAppointment[]>([]);
  const[selectedAppointment,setSelectedAppointment]=useState<Record<string,string>>({});
  const[loading,setLoading]=useState(true);
  const[pending,setPending]=useState<Set<string>>(()=>new Set());
  const[message,setMessage]=useState<string|null>(null);
  const[error,setError]=useState<string|null>(null);
  const requestSequence=useRef(0);

  const load=useCallback(async()=>{
    const requestId=++requestSequence.current;
    setLoading(true);setError(null);
    try{
      const[d,b]=await Promise.all([
        api.get<{deferredItems:DeferredServiceItem[]}>('/api/shop-os/deferred-service?statuses=open,reminded,booked,dismissed,completed'),
        api.get<AppointmentChoices>('/api/shop-os/deferred-service/appointment-choices')
      ]);
      if(requestId!==requestSequence.current)return;
      const nextItems=d.deferredItems??[];
      const nextAppointments=b.appointments??[];
      setItems(nextItems);
      setAppointments(nextAppointments);
      setSelectedAppointment(current=>{
        const next:Record<string,string>={};
        for(const item of nextItems){
          const selected=current[item.id]?.trim();
          if(selectedAppointmentStillEligible(selected,eligibleDeferredAppointments(item,nextAppointments))) next[item.id]=selected;
        }
        return next;
      });
    }catch(e){
      if(requestId!==requestSequence.current)return;
      setError(`Deferred service could not load. ${human(e instanceof Error?e.message:'request failed')}. Refresh and try again.`);
    }finally{if(requestId===requestSequence.current)setLoading(false)}
  },[]);

  useEffect(()=>{void load()},[load]);

  const ordered=useMemo(()=>[...items].sort((a,b)=>{
    const rank:Record<string,number>={open:0,reminded:1,booked:2,dismissed:3,completed:4};
    return (rank[a.status]??9)-(rank[b.status]??9)||new Date(a.next_follow_up_at??a.target_return_at??'9999-12-31').getTime()-new Date(b.next_follow_up_at??b.target_return_at??'9999-12-31').getTime();
  }),[items]);

  async function act(item:DeferredServiceItem,action:'remind'|'book'|'complete'|'dismiss'|'reopen'){
    if(pending.has(item.id))return;
    const appointmentId=selectedAppointment[item.id]?.trim();
    const choices=eligibleDeferredAppointments(item,appointments);
    if(action==='book'&&!selectedAppointmentStillEligible(appointmentId,choices)){
      setError('Choose a currently eligible matching appointment before marking deferred service booked.');
      return;
    }
    setPending(current=>{const next=new Set(current);next.add(item.id);return next});setMessage(null);setError(null);
    try{
      await api.patch(`/api/shop-os/deferred-service/${item.id}`,{action,...(action==='book'?{appointmentId}:{})});
      const labels={remind:'Customer reminder queued.',book:'Deferred service linked to the scheduled appointment.',complete:'Deferred service marked complete.',dismiss:'Deferred service dismissed.',reopen:'Deferred service reopened for follow-up.'};
      setMessage(labels[action]);
      await load();
    }catch(e){setError(`Deferred service was not updated. ${human(e instanceof Error?e.message:'request failed')}. Refresh and try again.`)}finally{
      setPending(current=>{const next=new Set(current);next.delete(item.id);return next});
    }
  }

  return <section className="mt-8" aria-labelledby="deferred-service-heading">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="kicker">Customer continuity</p><h2 id="deferred-service-heading" className="mt-1 text-2xl font-bold">Deferred service follow-up</h2><p className="muted mt-1 max-w-2xl text-sm">Keep declined and deferred work visible until it is reminded, rebooked, completed, or deliberately dismissed.</p></div><button className="secondary self-start" type="button" disabled={loading} onClick={()=>void load()}>{loading?'Refreshing…':'Refresh deferred service'}</button></div>
    {message&&<div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status" aria-live="polite">{message}</div>}
    {error&&<div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">{error}</div>}
    <div className="mt-5 space-y-3">{!loading&&ordered.length===0&&<div className="panel p-6"><p className="font-semibold">No deferred service to follow up</p><p className="muted mt-1 text-sm">Deferred recommendations will appear here automatically from repair-order decisions.</p></div>}{ordered.map(item=>{const choices=eligibleDeferredAppointments(item,appointments);const selectedId=selectedAppointment[item.id]?.trim();const selectedValid=selectedAppointmentStillEligible(selectedId,choices);const primary=deferredPrimaryAction(item.status);const busy=pending.has(item.id);return <article key={item.id} className="panel p-4"><div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-white/10 bg-white/[.04] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[.1em]">{human(item.status)}</span><span className="muted text-xs">{human(item.severity)}</span></div><h3 className="mt-2 font-bold">{item.line_description?.trim()||human(item.service_category)||'Deferred service'}</h3>{item.reason&&<p className="muted mt-1 text-sm">{item.reason}</p>}<div className="muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span>Estimate {money(item.estimated_amount)}</span><span>Return target {when(item.target_return_at)}</span><span>Next follow-up {when(item.next_follow_up_at)}</span><span>{item.follow_up_count??0} reminders</span></div>{item.booked_appointment_id&&<p className="mt-2 text-xs text-emerald-100">Booked appointment: {item.booked_appointment_id}</p>}</div><div className="flex min-w-[17rem] flex-col gap-2">{(item.status==='open'||item.status==='reminded')&&<><label className="text-xs"><span className="muted">Matching scheduled appointment</span><select className="input mt-1 w-full" disabled={busy} value={selectedValid?selectedId:''} onChange={e=>setSelectedAppointment(current=>({...current,[item.id]:e.target.value}))}><option value="">Choose appointment</option>{choices.map(a=><option key={a.id} value={a.id}>{when(a.starts_at)} · {human(a.service_category)}</option>)}</select></label>{choices.length===0&&<p className="muted text-xs">No matching held/confirmed appointment is available yet.</p>}<button className="primary" type="button" disabled={busy||!selectedValid} onClick={()=>void act(item,'book')}>{busy?'Updating…':'Link scheduled return'}</button></>}{primary&&<button className="secondary" type="button" disabled={busy} onClick={()=>void act(item,primary)}>{busy?'Updating…':primary==='remind'?'Send reminder':primary==='complete'?'Mark complete':'Reopen follow-up'}</button>}{['open','reminded','booked'].includes(item.status)&&<button className="secondary" type="button" disabled={busy} onClick={()=>void act(item,'dismiss')}>Dismiss follow-up</button>}{item.status==='completed'&&<p className="muted text-xs">Completed deferred work stays visible as service history.</p>}</div></div></article>})}</div>
  </section>;
}
