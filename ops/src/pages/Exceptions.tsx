import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDateTime, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type { CaseException, ExceptionState } from '../lib/types';

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  warning: 'bg-amber-100 text-amber-800',
  info: 'bg-slate-100 text-slate-700'
};

function errorMessage(error:unknown){
  if(error instanceof ApiError) return humanizeToken(error.message);
  return 'The exception could not be updated. Try again.';
}

function exceptionCode(exception:CaseException){
  return exception.exception_code ?? exception.code ?? 'exception';
}

function RecoveryControls({exception,onChanged}:{exception:CaseException;onChanged:()=>Promise<void>}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);

  async function move(state:ExceptionState){
    setBusy(true);setError(null);
    try{
      const payload:Record<string,string>={state};
      if(state==='resolved') payload.resolutionCode='operator_verified';
      await api.post(`/api/admin/exceptions/${exception.id}/state`,payload);
      await onChanged();
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }

  const actions: Array<{state:ExceptionState;label:string}> = exception.state==='open'
    ? [{state:'acknowledged',label:'Acknowledge'},{state:'remediating',label:'Start recovery'},{state:'resolved',label:'Resolve'}]
    : exception.state==='acknowledged'
      ? [{state:'remediating',label:'Start recovery'},{state:'resolved',label:'Resolve'}]
      : exception.state==='remediating'
        ? [{state:'acknowledged',label:'Pause recovery'},{state:'resolved',label:'Resolve'}]
        : [];

  if(!actions.length)return null;
  return <div className="mt-3 border-t border-slate-100 pt-3" onClick={(event)=>event.stopPropagation()}>
    <div className="flex flex-wrap gap-2">
      {actions.map(action=><button key={action.state} type="button" disabled={busy} onClick={()=>void move(action.state)} className="roviq-btn-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50">{action.label}</button>)}
    </div>
    {error&&<p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
  </div>;
}

export function Exceptions() {
  const [exceptions, setExceptions] = useState<CaseException[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter,setStateFilter]=useState<'active'|ExceptionState>('active');

  const load=useCallback(async()=>{
    setError(null);
    try{
      const suffix=stateFilter==='active'?'':`?state=${encodeURIComponent(stateFilter)}`;
      const res=await api.get<{ exceptions: CaseException[] }>(`/api/admin/exceptions/v2${suffix}`);
      setExceptions(stateFilter==='active'?res.exceptions.filter(item=>!['resolved','dismissed'].includes(item.state)):res.exceptions);
    }catch(e){setError(errorMessage(e));}
  },[stateFilter]);

  useEffect(() => { void load(); }, [load]);

  const overdue=useMemo(()=>exceptions?.filter(item=>item.due_at&&new Date(item.due_at).getTime()<Date.now()).length??0,[exceptions]);
  const critical=useMemo(()=>exceptions?.filter(item=>item.severity==='critical').length??0,[exceptions]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">Operations recovery</p><h1 className="text-xl font-semibold">Exception queue</h1><p className="mt-1 text-sm text-slate-600">Acknowledge, recover, and close operational exceptions without leaving the case context.</p></div>
        <label className="text-xs font-medium text-slate-600">Queue state<select value={stateFilter} onChange={event=>setStateFilter(event.target.value as 'active'|ExceptionState)} className="ml-2 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"><option value="active">Active</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="remediating">Remediating</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Visible</p><p className="mt-1 text-2xl font-semibold">{exceptions?.length??'—'}</p></div><div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Critical</p><p className="mt-1 text-2xl font-semibold">{exceptions?critical:'—'}</p></div><div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Past due</p><p className="mt-1 text-2xl font-semibold">{exceptions?overdue:'—'}</p></div></div>

      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {exceptions === null && !error && <p className="text-sm text-slate-500">Loading exception queue…</p>}
      {exceptions !== null && exceptions.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No exceptions in this queue.</p>}

      {exceptions !== null && exceptions.length > 0 && <ul className="space-y-3">
        {exceptions.map((e) => {
          const isOverdue=!!e.due_at&&new Date(e.due_at).getTime()<Date.now()&&!['resolved','dismissed'].includes(e.state);
          return <li key={e.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1"><Link to={`/cases/${e.case_id}`} className="font-medium text-slate-900 hover:underline">{e.summary}</Link><p className="mt-1 text-xs text-slate-500">{humanizeToken(exceptionCode(e))} · Case {humanizeToken(e.case_state)} · Raised {formatDateTime(e.created_at)}</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"><span>Recovery: <strong>{humanizeToken(e.state)}</strong></span>{e.owner_actor_id&&<span>Owner assigned</span>}<span className={isOverdue?'font-semibold text-red-700':''}>Due: {formatDateTime(e.due_at)}</span>{e.resolution_code&&<span>Resolution: {humanizeToken(e.resolution_code)}</span>}</div></div>
              <div className="flex items-center gap-2"><span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${SEVERITY_COLORS[e.severity] ?? SEVERITY_COLORS.info}`}>{e.severity}</span><StatusBadge state={e.case_state} /></div>
            </div>
            <RecoveryControls exception={e} onChanged={load}/>
          </li>;
        })}
      </ul>}
    </div>
  );
}
