import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { humanizeToken } from '../lib/format';

type Connection={
  id:string;
  organization_id:string|null;
  location_id:string|null;
  organization_name?:string|null;
  location_name?:string|null;
  display_name?:string|null;
  mode:string;
  connection_status:string;
};

type PilotCheck={
  key:string;
  status:'pass'|'blocker'|'warning';
  message:string;
  evidence?:Record<string,unknown>;
};

type PilotCase={id:string;state:string;priority:string;created_at:string;updated_at:string;added_at:string};

type PilotRun={
  id:string;
  organization_id:string;
  location_id:string;
  organization_name?:string|null;
  location_name?:string|null;
  status:'planned'|'ready'|'active'|'completed'|'aborted';
  readiness_snapshot:Record<string,unknown>;
  evidence:Record<string,unknown>;
  started_at?:string|null;
  completed_at?:string|null;
  aborted_at?:string|null;
  abort_reason?:string|null;
  created_at:string;
};

type PilotReadiness={
  scope:{organizationId:string;locationId:string|null};
  generatedAt:string;
  ready:boolean;
  blockerCount:number;
  warningCount:number;
  checks:PilotCheck[];
  nextActions:string[];
};

function badge(status:PilotCheck['status']){
  if(status==='pass') return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-200';
  if(status==='warning') return 'border-amber-300/30 bg-amber-400/10 text-amber-100';
  return 'border-rose-300/30 bg-rose-400/10 text-rose-100';
}

export function PilotReadinessPage(){
  const [connections,setConnections]=useState<Connection[]>([]);
  const [selected,setSelected]=useState('');
  const [readiness,setReadiness]=useState<PilotReadiness|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [runs,setRuns]=useState<PilotRun[]>([]);
  const [runBusy,setRunBusy]=useState(false);
  const [pilotCaseId,setPilotCaseId]=useState('');
  const [runCases,setRunCases]=useState<Record<string,PilotCase[]>>({});
  const [evidence,setEvidence]=useState({scheduling:false,repairOrder:false,notifications:false,payments:false,reconciliation:false});

  const nativeConnections=useMemo(
    ()=>connections.filter(connection=>connection.mode==='roviq_native'),
    [connections]
  );
  const activeConnection=nativeConnections.find(connection=>connection.id===selected)??nativeConnections[0]??null;

  async function loadConnections(){
    setLoading(true);
    setError('');
    try{
      const [result,pilotRuns]=await Promise.all([api.get<{connections:Connection[]}>('/api/admin/integrations/connections'),api.get<{runs:PilotRun[]}>('/api/admin/pilot/runs')]);
      setConnections(result.connections);
      setRuns(pilotRuns.runs);
      const first=result.connections.find(connection=>connection.mode==='roviq_native');
      if(first&&!selected) setSelected(first.id);
    }catch(err){
      setError(err instanceof Error?err.message:'Unable to load pilot connections');
    }finally{
      setLoading(false);
    }
  }

  async function evaluate(connection=activeConnection){
    if(!connection?.organization_id){
      setReadiness(null);
      setError('Select a ROVIQ-native partner connection with an organization.');
      return;
    }
    setLoading(true);
    setError('');
    try{
      const params=new URLSearchParams({organizationId:connection.organization_id});
      if(connection.location_id) params.set('locationId',connection.location_id);
      const result=await api.get<PilotReadiness>(`/api/admin/pilot/readiness?${params.toString()}`);
      setReadiness(result);
    }catch(err){
      setReadiness(null);
      setError(err instanceof Error?err.message:'Unable to evaluate pilot readiness');
    }finally{
      setLoading(false);
    }
  }

  async function refreshRuns(){
    const result=await api.get<{runs:PilotRun[]}>('/api/admin/pilot/runs');
    setRuns(result.runs);
  }

  async function createRun(){
    if(!activeConnection?.organization_id||!activeConnection.location_id||!readiness?.ready)return;
    setRunBusy(true); setError('');
    try{
      await api.post('/api/admin/pilot/runs',{organizationId:activeConnection.organization_id,locationId:activeConnection.location_id});
      await refreshRuns();
    }catch(err){setError(err instanceof Error?err.message:'Unable to create pilot run');}
    finally{setRunBusy(false);}
  }

  async function loadRunCases(id:string){
    const result=await api.get<{cases:PilotCase[]}>(`/api/admin/pilot/runs/${id}/cases`);
    setRunCases(current=>({...current,[id]:result.cases}));
  }

  async function linkCase(id:string){
    if(!pilotCaseId.trim())return;
    setRunBusy(true); setError('');
    try{
      const result=await api.post<{cases:PilotCase[]}>(`/api/admin/pilot/runs/${id}/cases`,{caseId:pilotCaseId.trim()});
      setRunCases(current=>({...current,[id]:result.cases}));
      setPilotCaseId('');
    }catch(err){setError(err instanceof Error?err.message:'Unable to link pilot case');}
    finally{setRunBusy(false);}
  }

  async function startRun(id:string){
    setRunBusy(true); setError('');
    try{await api.post(`/api/admin/pilot/runs/${id}/start`,{});await refreshRuns();await evaluate();}
    catch(err){setError(err instanceof Error?err.message:'Unable to start pilot run');}
    finally{setRunBusy(false);}
  }

  async function completeRun(id:string){
    if(!Object.values(evidence).every(Boolean))return;
    setRunBusy(true); setError('');
    try{
      await api.post(`/api/admin/pilot/runs/${id}/finish`,{outcome:'completed',evidence});
      await refreshRuns();
      setEvidence({scheduling:false,repairOrder:false,notifications:false,payments:false,reconciliation:false});
    }catch(err){setError(err instanceof Error?err.message:'Unable to complete pilot run');}
    finally{setRunBusy(false);}
  }

  async function abortRun(id:string){
    const reason=window.prompt('Why is this pilot run being aborted?');
    if(!reason?.trim())return;
    setRunBusy(true); setError('');
    try{await api.post(`/api/admin/pilot/runs/${id}/finish`,{outcome:'aborted',abortReason:reason.trim()});await refreshRuns();}
    catch(err){setError(err instanceof Error?err.message:'Unable to abort pilot run');}
    finally{setRunBusy(false);}
  }

  useEffect(()=>{void loadConnections();},[]);
  useEffect(()=>{
    const connection=nativeConnections.find(item=>item.id===selected);
    if(connection) void evaluate(connection);
  },[selected,connections.length]);
  useEffect(()=>{
    const openRun=runs.find(run=>run.location_id===activeConnection?.location_id&&['ready','active'].includes(run.status));
    if(openRun) void loadRunCases(openRun.id);
  },[runs.map(run=>`${run.id}:${run.status}`).join('|'),activeConnection?.location_id]);

  return <section className="space-y-5" aria-labelledby="pilot-title">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.14em] text-[var(--roviq-muted)]">Controlled pilot gate</p>
        <h1 id="pilot-title" className="mt-1 text-2xl font-bold text-slate-950">Shop OS pilot readiness</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">A fail-closed operational check before real partner traffic reaches a ROVIQ-native location.</p>
      </div>
      <button className="roviq-btn-secondary self-start sm:self-auto" onClick={()=>void evaluate()} disabled={loading||!activeConnection}>
        {loading?'Checking…':'Recheck readiness'}
      </button>
    </div>

    <div className="roviq-panel p-4">
      <label htmlFor="pilot-connection" className="text-xs font-semibold uppercase tracking-wide text-[var(--roviq-muted)]">Pilot location</label>
      <select id="pilot-connection" className="roviq-input mt-2" value={activeConnection?.id??''} onChange={event=>setSelected(event.target.value)}>
        {nativeConnections.length===0&&<option value="">No ROVIQ-native connection configured</option>}
        {nativeConnections.map(connection=><option key={connection.id} value={connection.id}>
          {connection.organization_name??connection.display_name??'Partner'} · {connection.location_name??'No location'} · {humanizeToken(connection.connection_status)}
        </option>)}
      </select>
    </div>

    {error&&<div role="alert" aria-live="assertive" className="rounded-xl border border-rose-300/30 bg-rose-400/10 p-4 text-sm text-rose-100">{error}</div>}

    {!error&&loading&&!readiness&&<div className="roviq-panel p-6 text-sm text-[var(--roviq-muted)]" role="status" aria-live="polite">Evaluating pilot prerequisites…</div>}

    {activeConnection&&<div className="roviq-panel p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">Pilot execution record</h2>
          <p className="mt-1 text-sm text-[var(--roviq-muted)]">Create the run only after the readiness gate passes. Starting revalidates the gate again.</p>
        </div>
        <button className="roviq-btn-primary" disabled={!readiness?.ready||!activeConnection.location_id||runBusy||runs.some(run=>run.location_id===activeConnection.location_id&&['ready','active'].includes(run.status))} onClick={()=>void createRun()}>
          {runBusy?'Working…':'Create pilot run'}
        </button>
      </div>

      {runs.filter(run=>run.location_id===activeConnection.location_id).slice(0,3).map(run=><article key={run.id} className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <strong>Pilot {run.id.slice(0,8)}</strong>
              <span className="rounded-full border border-white/10 px-2 py-1 text-xs font-semibold">{humanizeToken(run.status)}</span>
            </div>
            <p className="mt-1 text-xs text-[var(--roviq-muted)]">Created {new Date(run.created_at).toLocaleString()}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {run.status==='ready'&&<button className="roviq-btn-primary" disabled={runBusy} onClick={()=>void startRun(run.id)}>Start controlled pilot</button>}
            {['ready','active'].includes(run.status)&&<button className="roviq-btn-secondary" disabled={runBusy} onClick={()=>void abortRun(run.id)}>Abort</button>}
          </div>
        </div>

        {run.status==='active'&&<div className="mt-4 border-t border-white/10 pt-4">
          <div className="text-sm font-semibold">Completion evidence</div>
          <p className="mt-1 text-xs text-[var(--roviq-muted)]">Confirm each live workflow was actually exercised before marking the run complete.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(evidence).map(([key,value])=><label key={key} className="flex min-h-11 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-sm">
              <input type="checkbox" checked={value} onChange={event=>setEvidence(current=>({...current,[key]:event.target.checked}))}/>
              {humanizeToken(key)}
            </label>)}
          </div>
          <button className="roviq-btn-primary mt-3" disabled={runBusy||!Object.values(evidence).every(Boolean)} onClick={()=>void completeRun(run.id)}>Complete pilot run</button>
        </div>}

        {run.status==='completed'&&<div className="mt-3 text-sm text-emerald-200">Completed with retained evidence.</div>}
        {run.status==='aborted'&&<div className="mt-3 text-sm text-rose-200">Aborted{run.abort_reason?`: ${run.abort_reason}`:''}</div>}
      </article>)}
    </div>}

    {readiness&&<div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="roviq-panel p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--roviq-muted)]">Gate</div>
          <div className={`mt-1 text-2xl font-bold ${readiness.ready?'text-emerald-300':'text-rose-300'}`}>{readiness.ready?'Ready':'Blocked'}</div>
        </div>
        <div className="roviq-panel p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--roviq-muted)]">Blockers</div>
          <div className="mt-1 text-2xl font-bold">{readiness.blockerCount}</div>
        </div>
        <div className="roviq-panel p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--roviq-muted)]">Warnings</div>
          <div className="mt-1 text-2xl font-bold">{readiness.warningCount}</div>
        </div>
      </div>

      {!readiness.ready&&readiness.nextActions.length>0&&<div className="rounded-xl border border-rose-300/30 bg-rose-400/10 p-4">
        <h2 className="font-semibold text-rose-100">Resolve before pilot traffic</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-rose-100">
          {readiness.nextActions.map(action=><li key={action}>{action}</li>)}
        </ol>
      </div>}

      <div className="grid gap-3 lg:grid-cols-2">
        {readiness.checks.map(check=><article key={check.key} className="roviq-panel p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{humanizeToken(check.key)}</div>
              <p className="mt-1 text-sm text-[var(--roviq-muted)]">{check.message}</p>
            </div>
            <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${badge(check.status)}`}>{humanizeToken(check.status)}</span>
          </div>
          {check.evidence&&<dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            {Object.entries(check.evidence).map(([key,value])=><div key={key} className="rounded-lg border border-white/10 bg-white/5 p-2">
              <dt className="text-[var(--roviq-muted)]">{humanizeToken(key)}</dt>
              <dd className="mt-1 break-words font-medium">{typeof value==='object'?JSON.stringify(value):String(value??'—')}</dd>
            </div>)}
          </dl>}
        </article>)}
      </div>
    </div>}
  </section>;
}
