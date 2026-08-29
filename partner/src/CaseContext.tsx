import { useEffect, useState } from 'react';
import { api } from './api';

type Spatial={origin?:unknown;current_vehicle?:unknown;provider_location?:unknown;destination?:unknown;route_context?:Record<string,unknown>};

function loc(v:unknown){
  if(!v)return'Not available yet';
  if(typeof v==='string')return v;
  if(typeof v==='object'){
    const o=v as Record<string,unknown>;
    const text=[o.name,o.label,o.address,o.formatted_address,o.description].find(x=>typeof x==='string');
    if(typeof text==='string')return text;
  }
  return'Location attached to case';
}

export function CaseContext({caseId}:{caseId:string}){
  const[spatial,setSpatial]=useState<Spatial|null>(null);
  const[error,setError]=useState('');
  useEffect(()=>{let live=true;api.get<{spatial:Spatial}>(`/api/maintenance/cases/${caseId}/spatial`).then(r=>{if(live)setSpatial(r.spatial)}).catch(()=>{if(live)setError('Case movement context is not available yet.')});return()=>{live=false}},[caseId]);
  const route=spatial?.route_context??{};
  return <section className="panel mt-5 overflow-hidden">
    <div className="p-5"><p className="kicker">Selected case</p><h2 className="mt-1 text-xl font-bold">Incoming service context</h2><p className="muted mt-2 text-sm">Only the vehicle movement and destination needed to receive this assigned case are shown.</p></div>
    {error?<div className="border-t border-white/10 p-5 text-sm text-white/60">{error}</div>:<div className="grid gap-px border-t border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
      <div className="bg-[var(--panel)] p-4"><p className="kicker">Origin</p><p className="mt-2 text-sm font-semibold">{loc(spatial?.origin)}</p></div>
      <div className="bg-[var(--panel)] p-4"><p className="kicker">Vehicle</p><p className="mt-2 text-sm font-semibold">{loc(spatial?.current_vehicle)}</p></div>
      <div className="bg-[var(--panel)] p-4"><p className="kicker">Service destination</p><p className="mt-2 text-sm font-semibold">{loc(spatial?.provider_location??spatial?.destination)}</p></div>
      <div className="bg-[var(--panel)] p-4"><p className="kicker">ETA</p><p className="mt-2 text-sm font-semibold">{String(route.etaMinutes??'—')} min</p></div>
    </div>}
  </section>;
}
