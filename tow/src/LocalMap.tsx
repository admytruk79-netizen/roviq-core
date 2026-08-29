import { useEffect, useState } from 'react';

type Spatial = {
  case_id?: string;
  origin?: unknown;
  current_vehicle?: unknown;
  destination?: unknown;
  transport_location?: unknown;
  route_context?: Record<string, unknown>;
  updated_at?: string;
};

const BASE=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'');
const TOKEN='roviq_tow_token';

function label(value: unknown) {
  if (!value) return 'Not available yet';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v=value as Record<string,unknown>;
    const text=[v.name,v.label,v.address,v.formatted_address,v.description].find(x=>typeof x==='string');
    if (typeof text === 'string') return text;
    const lat=v.lat??v.latitude, lng=v.lng??v.lon??v.longitude;
    if (typeof lat === 'number' && typeof lng === 'number') return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
  return 'Location available in case data';
}

function metric(route: Record<string,unknown>|undefined, key:string) {
  const value=route?.[key];
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '—';
}

export function LocalMap({caseId}:{caseId:string}) {
  const [spatial,setSpatial]=useState<Spatial|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let cancelled=false;
    const token=localStorage.getItem(TOKEN);
    fetch(`${BASE}/api/maintenance/cases/${caseId}/spatial`,{headers:token?{authorization:`Bearer ${token}`}:{}})
      .then(async r=>{if(!r.ok)throw new Error(`spatial_${r.status}`);return r.json() as Promise<{spatial:Spatial}>})
      .then(r=>{if(!cancelled)setSpatial(r.spatial)})
      .catch(()=>{if(!cancelled)setError('Case route context is not available yet.')});
    return()=>{cancelled=true};
  },[caseId]);

  const route=spatial?.route_context;
  return <section className="map-panel dispatch-context">
    <div className="map-head"><div><span className="eyebrow map-eyebrow">Case spatial context</span><h2>Dispatch route</h2><p>Only the pickup, vehicle movement, destination and ETA for this assigned case are shown here.</p></div></div>
    {error?<div className="spatial-empty">{error}</div>:<div className="spatial-grid">
      <div><span>Pickup</span><strong>{label(spatial?.origin)}</strong></div>
      <div><span>Vehicle</span><strong>{label(spatial?.current_vehicle)}</strong></div>
      <div><span>Destination</span><strong>{label(spatial?.destination)}</strong></div>
      <div><span>Tow position</span><strong>{label(spatial?.transport_location)}</strong></div>
      <div><span>Distance</span><strong>{metric(route,'distanceMiles')} mi</strong></div>
      <div><span>ETA</span><strong>{metric(route,'etaMinutes')} min</strong></div>
    </div>}
  </section>;
}
