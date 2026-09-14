import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { formatDateTime, humanizeToken } from '../lib/format';

type OperationalHealth={
  health:'healthy'|'attention'|'degraded'|'paused'|'failed'|'revoked'|'planned';
  reasons:string[];
  fallbackActive:boolean;
};

type Connection={
  id:string;
  organization_name?:string|null;
  location_name?:string|null;
  display_name?:string|null;
  provider_key?:string|null;
  mode:'native_integration'|'roviq_native'|'bridge';
  connection_status:string;
  credential_state:string;
  access_state:string;
  last_success_at?:string|null;
  last_failure_at?:string|null;
  latest_event_at?:string|null;
  last_error?:string|null;
  failures_24h?:number|string|null;
  fallback_enabled?:boolean;
  fallback_mode?:string|null;
  operational:OperationalHealth;
};

const healthRank:Record<OperationalHealth['health'],number>={
  failed:0,revoked:1,degraded:2,attention:3,paused:4,planned:5,healthy:6
};

function healthClass(health:OperationalHealth['health']){
  if(health==='healthy') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if(health==='attention'||health==='planned'||health==='paused') return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-rose-200 bg-rose-50 text-rose-800';
}

export function IntegrationHealth(){
  const [connections,setConnections]=useState<Connection[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);

  async function load(){
    setLoading(true);
    setError(null);
    try{
      const result=await api.get<{connections:Connection[]}>('/api/admin/integrations/connections');
      setConnections(result.connections);
    }catch(err){
      setError(err instanceof Error?err.message:'Unable to load integration health');
    }finally{
      setLoading(false);
    }
  }

  useEffect(()=>{ void load(); },[]);

  const ordered=useMemo(()=>[...connections].sort((a,b)=>{
    const rank=healthRank[a.operational.health]-healthRank[b.operational.health];
    if(rank!==0)return rank;
    return (a.organization_name??a.display_name??'').localeCompare(b.organization_name??b.display_name??'');
  }),[connections]);

  const degraded=connections.filter(connection=>['failed','revoked','degraded','attention'].includes(connection.operational.health)).length;
  const healthy=connections.filter(connection=>connection.operational.health==='healthy').length;

  return <section className="space-y-5" aria-labelledby="integration-health-title">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.14em] text-[var(--roviq-muted)]">Network operations</p>
        <h1 id="integration-health-title" className="mt-1 text-2xl font-bold text-slate-950">Integration health</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">Connector freshness, credentials, access, failures, and degraded fallback state in one operational view.</p>
      </div>
      <button className="roviq-btn-secondary self-start sm:self-auto" onClick={()=>void load()} disabled={loading}>{loading?'Refreshing…':'Refresh'}</button>
    </div>

    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Connections</div><div className="mt-1 text-2xl font-bold text-slate-950">{connections.length}</div></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Healthy</div><div className="mt-1 text-2xl font-bold text-slate-950">{healthy}</div></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Needs attention</div><div className="mt-1 text-2xl font-bold text-slate-950">{degraded}</div></div>
    </div>

    {error&&<div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><div className="font-semibold">Integration health could not be loaded.</div><div className="mt-1">{error}</div><button className="mt-3 underline" onClick={()=>void load()}>Try again</button></div>}

    {!error&&loading&&<div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500" aria-live="polite">Loading connector health…</div>}

    {!error&&!loading&&ordered.length===0&&<div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">No partner connections are configured yet.</div>}

    {!error&&!loading&&ordered.length>0&&<div className="space-y-3">
      {ordered.map(connection=><article key={connection.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-slate-950">{connection.organization_name??connection.display_name??connection.provider_key??'Integration'}</h2>
              <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${healthClass(connection.operational.health)}`}>{humanizeToken(connection.operational.health)}</span>
              {connection.operational.fallbackActive&&<span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">Fallback active</span>}
            </div>
            <p className="mt-1 text-sm text-slate-600">{connection.location_name??'All locations'} · {humanizeToken(connection.mode)} · {connection.provider_key??'ROVIQ'}</p>
          </div>
          <div className="text-sm text-slate-600 lg:text-right">
            <div>Last success: <span className="font-medium text-slate-900">{formatDateTime(connection.last_success_at??null)}</span></div>
            <div>Failures, 24h: <span className="font-medium text-slate-900">{Number(connection.failures_24h??0)}</span></div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Connection</div><div className="mt-1 font-medium text-slate-900">{humanizeToken(connection.connection_status)}</div></div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Credentials</div><div className="mt-1 font-medium text-slate-900">{humanizeToken(connection.credential_state)}</div></div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Access</div><div className="mt-1 font-medium text-slate-900">{humanizeToken(connection.access_state)}</div></div>
        </div>

        {connection.operational.reasons.length>0&&<div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why this needs attention</div>
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Integration health reasons">
            {connection.operational.reasons.map(reason=><li key={reason} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700">{humanizeToken(reason)}</li>)}
          </ul>
        </div>}

        {connection.last_error&&<div className="mt-4 rounded-lg border border-rose-100 bg-rose-50 p-3 text-sm text-rose-800"><span className="font-semibold">Latest error:</span> {connection.last_error}</div>}
      </article>)}
    </div>}
  </section>;
}
