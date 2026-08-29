import { useEffect,useRef,useState } from 'react';
import maplibregl from 'maplibre-gl';

type Point={lat:number;lng:number};
type Spatial={origin?:unknown;current_vehicle?:unknown;destination?:unknown;transport_location?:unknown};
type Props={caseId?:string;dispatchId?:string;dispatchStatus?:string};

const BASE=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'');
const TOKEN='roviq_tow_token';
const PORTLAND:Point={lat:45.5231,lng:-122.6765};

const STYLE:maplibregl.StyleSpecification={
  version:8,
  sources:{
    osm:{
      type:'raster',
      tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize:256,
      attribution:'© OpenStreetMap contributors'
    }
  },
  layers:[
    {id:'background',type:'background',paint:{'background-color':'#071019'}},
    {id:'osm',type:'raster',source:'osm',minzoom:0,maxzoom:19,paint:{'raster-opacity':0.92,'raster-saturation':-0.45,'raster-contrast':0.18,'raster-brightness-min':0.18,'raster-brightness-max':0.72}}
  ]
};

function auth():Record<string,string>{const t=localStorage.getItem(TOKEN);return t?{authorization:`Bearer ${t}`}:{}}
function point(value:unknown):Point|null{
  if(!value||typeof value!=='object')return null;
  const v=value as Record<string,unknown>;
  const lat=Number(v.lat??v.latitude),lng=Number(v.lng??v.lon??v.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180?{lat,lng}:null;
}
function marker(label:string,kind:string){
  const el=document.createElement('div');
  el.className=`rq-marker rq-dispatch-marker ${kind}`;
  el.innerHTML=`<span>${label}</span>`;
  return el;
}

export function LocalMap({caseId,dispatchId,dispatchStatus}:Props){
  const host=useRef<HTMLDivElement|null>(null);
  const mapRef=useRef<maplibregl.Map|null>(null);
  const markersRef=useRef<maplibregl.Marker[]>([]);
  const [spatial,setSpatial]=useState<Spatial|null>(null);
  const [error,setError]=useState('');

  useEffect(()=>{
    if(!caseId){setSpatial(null);return;}
    let dead=false;
    const load=async()=>{
      try{
        const r=await fetch(`${BASE}/api/maintenance/cases/${caseId}/spatial`,{headers:auth(),cache:'no-store'});
        if(!r.ok)throw new Error();
        const d=await r.json() as {spatial:Spatial};
        if(!dead){setSpatial(d.spatial);setError('');}
      }catch{
        if(!dead)setError('Case route context is not available yet.');
      }
    };
    void load();
    const id=setInterval(()=>void load(),10000);
    return()=>{dead=true;clearInterval(id)};
  },[caseId]);

  useEffect(()=>{
    if(!host.current||mapRef.current)return;
    const map=new maplibregl.Map({
      container:host.current,
      style:STYLE,
      center:[PORTLAND.lng,PORTLAND.lat],
      zoom:11.5,
      pitch:18,
      bearing:0,
      attributionControl:false,
      minZoom:3,
      maxZoom:19
    });
    map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
    map.on('load',()=>{map.resize();setError('');});
    map.on('error',()=>setError('Map tiles are temporarily unavailable.'));
    const timer=setTimeout(()=>map.resize(),250);
    mapRef.current=map;
    return()=>{
      clearTimeout(timer);
      markersRef.current.forEach(m=>m.remove());
      markersRef.current=[];
      map.remove();
      mapRef.current=null;
    };
  },[]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map)return;
    markersRef.current.forEach(m=>m.remove());
    markersRef.current=[];
    const pickup=point(spatial?.origin)??point(spatial?.current_vehicle);
    const destination=point(spatial?.destination);
    const vehicle=point(spatial?.transport_location);
    if(pickup)markersRef.current.push(new maplibregl.Marker({element:marker('P','pickup')}).setLngLat([pickup.lng,pickup.lat]).addTo(map));
    if(destination)markersRef.current.push(new maplibregl.Marker({element:marker('D','destination')}).setLngLat([destination.lng,destination.lat]).addTo(map));
    if(vehicle)markersRef.current.push(new maplibregl.Marker({element:marker('V','vehicle')}).setLngLat([vehicle.lng,vehicle.lat]).addTo(map));
    const pts=[pickup,destination,vehicle].filter(Boolean) as Point[];
    const fit=()=>{
      map.resize();
      if(pts.length>1){
        const b=new maplibregl.LngLatBounds();
        pts.forEach(p=>b.extend([p.lng,p.lat]));
        map.fitBounds(b,{padding:56,maxZoom:15,duration:500});
      }else if(pts[0]){
        map.easeTo({center:[pts[0].lng,pts[0].lat],zoom:14,duration:400});
      }
    };
    if(map.loaded())fit();else map.once('load',fit);
  },[spatial]);

  return <section className="map-panel dispatch-context">
    <div className="map-head"><div>
      <span className="eyebrow map-eyebrow">Tow case map</span>
      <h2>Pickup · route · destination</h2>
      <p>{dispatchId?`Dispatch ${dispatchId.slice(0,8)}`:'Live operational map'}{dispatchStatus?` · ${dispatchStatus.replaceAll('_',' ')}`:''}</p>
    </div></div>
    <div className="live-map-wrap"><div ref={host} className="live-map"/>{error&&<div className="map-warning">{error}</div>}</div>
  </section>;
}
