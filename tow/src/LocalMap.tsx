import { useEffect, useMemo, useState } from 'react';

type Point={lat:number;lng:number};
type Spatial={origin?:unknown;current_vehicle?:unknown;destination?:unknown};
const BASE=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'');
const TOKEN='roviq_tow_token';
const LOCAL='https://roviq-local2.admytruk79.workers.dev/operational-tow.html';

function auth():Record<string,string>{const t=localStorage.getItem(TOKEN);return t?{authorization:`Bearer ${t}`}:{}}
function point(value:unknown):Point|null{if(!value||typeof value!=='object')return null;const v=value as Record<string,unknown>;const lat=Number(v.lat??v.latitude),lng=Number(v.lng??v.lon??v.longitude);return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180?{lat,lng}:null}

export function LocalMap({caseId}:{caseId?:string}){
  const[spatial,setSpatial]=useState<Spatial|null>(null);
  const[error,setError]=useState('');

  useEffect(()=>{if(!caseId){setSpatial(null);setError('');return}let dead=false;const load=async()=>{try{const r=await fetch(`${BASE}/api/maintenance/cases/${caseId}/spatial`,{headers:auth(),cache:'no-store'});if(!r.ok)throw new Error();const d=await r.json() as {spatial:Spatial};if(!dead){setSpatial(d.spatial);setError('')}}catch{if(!dead)setError('Case route context is not available yet.')}};void load();const id=setInterval(()=>void load(),10000);return()=>{dead=true;clearInterval(id)}},[caseId]);

  const src=useMemo(()=>{const p=point(spatial?.origin)??point(spatial?.current_vehicle);const d=point(spatial?.destination);const q=new URLSearchParams();if(p){q.set('pickupLat',String(p.lat));q.set('pickupLng',String(p.lng))}if(d){q.set('destinationLat',String(d.lat));q.set('destinationLng',String(d.lng))}return `${LOCAL}${q.toString()?`?${q.toString()}`:''}`},[spatial]);

  return <section className="map-panel dispatch-context"><div className="map-head"><div><span className="eyebrow map-eyebrow">ROVIQ Local · Tow</span><h2>Operational tow map</h2><p>Existing ROVIQ Local operational map, with Tow case context passed in.</p></div></div><div className="live-map-wrap"><iframe key={src} className="live-map-frame" src={src} title="ROVIQ Local operational tow map" allow="geolocation" referrerPolicy="no-referrer"/>{error&&<div className="map-warning">{error}</div>}</div></section>;
}
