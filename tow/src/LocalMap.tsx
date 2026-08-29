import {useEffect,useRef,useState} from 'react';
import maplibregl from 'maplibre-gl';

type Point={lat:number;lng:number};
type LivePoint=Point&{heading:number|null;accuracy:number|null;speed:number|null};
type Spatial={origin?:unknown;current_vehicle?:unknown;destination?:unknown;transport_location?:unknown;route_context?:Record<string,unknown>};
type RouteStep={type?:string;modifier?:string;name?:string;instruction?:string;location?:number[]};
type Route={geometry?:{coordinates?:number[][]};distance?:number;duration?:number;steps?:RouteStep[]};
type RoutePayload={route?:Route};
type Props={caseId?:string;dispatchId?:string;dispatchStatus?:string};

const BASE=(import.meta.env.VITE_API_BASE_URL??'').replace(/\/$/,'');
const TOKEN='roviq_tow_token';
const STYLE={day:'https://tiles.stadiamaps.com/styles/alidade_smooth.json',night:'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json'};
const PICKUP_STATES=new Set(['assigned','accepted','en_route','arrived']);

function auth():Record<string,string>{const t=localStorage.getItem(TOKEN);return t?{authorization:`Bearer ${t}`}:{}}
function point(value:unknown):Point|null{if(!value||typeof value!=='object')return null;const v=value as Record<string,unknown>;const lat=Number(v.lat??v.latitude),lng=Number(v.lng??v.lon??v.longitude);return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180?{lat,lng}:null}
function label(value:unknown){if(!value)return'Not available yet';if(typeof value==='string')return value;if(typeof value==='object'){const v=value as Record<string,unknown>;const text=[v.name,v.label,v.address,v.formatted_address,v.description].find(x=>typeof x==='string');if(typeof text==='string')return text;const p=point(v);if(p)return`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}return'Location available in case data'}
function rad(x:number){return x*Math.PI/180}
function distanceM(a:Point,b:Point){const R=6371000,dLat=rad(b.lat-a.lat),dLng=rad(b.lng-a.lng),q=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(q)))}
function stepLabel(step?:RouteStep|null){if(!step)return'';if(step.instruction)return step.instruction;const dir=step.modifier?` ${step.modifier}`:'';if(step.type==='turn')return`Turn${dir}${step.name?` onto ${step.name}`:''}`;if(step.type==='depart')return`Start${step.name?` on ${step.name}`:''}`;if(step.type==='arrive')return'Arrive at destination';return`${step.type||'Continue'}${dir}${step.name?` on ${step.name}`:''}`}
function nextStep(route:Route|null,current:Point|null){const steps=route?.steps??[];if(!steps.length)return null;if(!current)return steps[0];let best=steps[0],bestD=Infinity;for(const s of steps){if(!Array.isArray(s.location)||s.location.length<2)continue;const p={lng:Number(s.location[0]),lat:Number(s.location[1])};if(!Number.isFinite(p.lng)||!Number.isFinite(p.lat))continue;const d=distanceM(current,p);if(d<bestD){bestD=d;best=s}}return best}
function endpointMarker(kind:'pickup'|'destination'){const el=document.createElement('button');el.type='button';el.className=`rq-marker rq-dispatch-marker ${kind}`;el.innerHTML=kind==='pickup'?'<span>P</span>':'<span>D</span>';return el}
function towPuck(heading:number|null){const el=document.createElement('div');el.className='rq-nav-puck';el.style.setProperty('--rq-heading',`${Number.isFinite(heading)?heading:0}deg`);el.innerHTML='<span></span>';return el}

export function LocalMap({caseId,dispatchId,dispatchStatus}:Props){
  const[spatial,setSpatial]=useState<Spatial|null>(null);
  const[live,setLive]=useState<LivePoint|null>(null);
  const[route,setRoute]=useState<Route|null>(null);
  const[tracking,setTracking]=useState<'starting'|'live'|'limited'>('starting');
  const[error,setError]=useState('');
  const[following,setFollowing]=useState(true);
  const mapNode=useRef<HTMLDivElement|null>(null);
  const mapRef=useRef<maplibregl.Map|null>(null);
  const markers=useRef<maplibregl.Marker[]>([]);
  const lastPush=useRef(0),lastRouteAt=useRef(0),lastRouted=useRef<Point|null>(null),lastTarget=useRef('');
  const assigned=Boolean(caseId&&dispatchId);
  const mode:(keyof typeof STYLE)=document.documentElement.dataset.roviqMode==='day'?'day':document.documentElement.dataset.roviqMode==='night'?'night':(new Date().getHours()>=7&&new Date().getHours()<19?'day':'night');

  useEffect(()=>{if(!caseId){setSpatial(null);return}let dead=false;const load=async()=>{try{const r=await fetch(`${BASE}/api/maintenance/cases/${caseId}/spatial`,{headers:auth(),cache:'no-store'});if(!r.ok)throw new Error();const d=await r.json() as {spatial:Spatial};if(!dead){setSpatial(d.spatial);setError('')}}catch{if(!dead)setError('Case route context is not available yet.')}};void load();const id=setInterval(()=>void load(),10000);return()=>{dead=true;clearInterval(id)}},[caseId]);

  useEffect(()=>{if(!navigator.geolocation){setTracking('limited');return}const id=navigator.geolocation.watchPosition(pos=>{const p:LivePoint={lat:pos.coords.latitude,lng:pos.coords.longitude,heading:Number.isFinite(pos.coords.heading)?pos.coords.heading:null,accuracy:Number.isFinite(pos.coords.accuracy)?pos.coords.accuracy:null,speed:Number.isFinite(pos.coords.speed)?pos.coords.speed:null};setLive(p);setTracking('live');const now=Date.now();if(dispatchId&&now-lastPush.current>8000){lastPush.current=now;void fetch(`${BASE}/api/transport/${dispatchId}/location`,{method:'POST',headers:{'content-type':'application/json',...auth()},body:JSON.stringify({lat:p.lat,lng:p.lng,accuracy:p.accuracy,heading:p.heading,speed:p.speed,capturedAt:new Date(pos.timestamp).toISOString()})}).catch(()=>{})}},()=>setTracking('limited'),{enableHighAccuracy:true,maximumAge:1500,timeout:10000});return()=>navigator.geolocation.clearWatch(id)},[dispatchId]);

  useEffect(()=>{if(!mapNode.current||mapRef.current)return;const center=live??point(spatial?.transport_location)??point(spatial?.origin)??point(spatial?.destination)??{lat:45.5231,lng:-122.6765};const map=new maplibregl.Map({container:mapNode.current,style:STYLE[mode],center:[center.lng,center.lat],zoom:12.5,pitch:assigned?42:18,bearing:0,attributionControl:{compact:true},minZoom:3,maxZoom:18});map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');mapRef.current=map;map.on('dragstart',()=>setFollowing(false));map.on('load',()=>{setError('');map.resize();void renderMap(true)});map.on('styledata',()=>drawRoute(route));map.on('error',()=>setError('ROVIQ Local map tiles are temporarily unavailable.'));const resize=setTimeout(()=>map.resize(),250);return()=>{clearTimeout(resize);markers.current.forEach(m=>m.remove());markers.current=[];map.remove();mapRef.current=null}},[]);

  useEffect(()=>{void renderMap(false)},[spatial,live,dispatchStatus]);
  useEffect(()=>{drawRoute(route)},[route]);

  function pickup(){return point(spatial?.origin)??point(spatial?.current_vehicle)}
  function destination(){return point(spatial?.destination)}
  function target(){const p=pickup(),d=destination();return dispatchStatus&&PICKUP_STATES.has(dispatchStatus)?p:(d??p)}

  async function requestRoute(from:Point,to:Point,force:boolean){const key=`${to.lng.toFixed(5)},${to.lat.toFixed(5)}`,changed=key!==lastTarget.current,moved=lastRouted.current?distanceM(from,lastRouted.current):Infinity;if(!force&&!changed&&Date.now()-lastRouteAt.current<10000&&moved<45)return;lastTarget.current=key;lastRouteAt.current=Date.now();lastRouted.current={...from};try{const r=await fetch(`${BASE}/api/local/route?from=${encodeURIComponent(`${from.lng},${from.lat}`)}&to=${encodeURIComponent(`${to.lng},${to.lat}`)}`,{cache:'no-store'});const d=await r.json() as RoutePayload;if(!r.ok||!d.route?.geometry?.coordinates?.length)throw new Error();setRoute(d.route);setError('')}catch{setError('ROVIQ Local road route is temporarily unavailable.')}}

  function drawRoute(r:Route|null){const map=mapRef.current;if(!map||!map.loaded())return;const coords=r?.geometry?.coordinates??[];try{const data:any={type:'Feature',properties:{},geometry:{type:'LineString',coordinates:coords}};const src=map.getSource('rq-nav-route') as maplibregl.GeoJSONSource|undefined;if(src)src.setData(data);else if(coords.length)map.addSource('rq-nav-route',{type:'geojson',data});if(coords.length&&!map.getLayer('rq-nav-route-casing'))map.addLayer({id:'rq-nav-route-casing',type:'line',source:'rq-nav-route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#07151a','line-width':10,'line-opacity':.82}});if(coords.length&&!map.getLayer('rq-nav-route'))map.addLayer({id:'rq-nav-route',type:'line',source:'rq-nav-route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#55dfce','line-width':5.2,'line-opacity':.96}})}catch{}}

  async function renderMap(force:boolean){const map=mapRef.current;if(!map||!map.loaded())return;const tow=live??point(spatial?.transport_location),p=pickup(),d=destination(),t=target();markers.current.forEach(m=>m.remove());markers.current=[];if(p)markers.current.push(new maplibregl.Marker({element:endpointMarker('pickup'),anchor:'center'}).setLngLat([p.lng,p.lat]).addTo(map));if(d)markers.current.push(new maplibregl.Marker({element:endpointMarker('destination'),anchor:'center'}).setLngLat([d.lng,d.lat]).addTo(map));if(tow)markers.current.push(new maplibregl.Marker({element:towPuck(live?.heading??null),anchor:'center',rotationAlignment:'map'}).setLngLat([tow.lng,tow.lat]).addTo(map));if(tow&&t)await requestRoute(tow,t,force);if(tow&&following)map.easeTo({center:[tow.lng,tow.lat],zoom:Math.max(map.getZoom(),15.2),pitch:assigned?50:28,bearing:live?.heading??map.getBearing(),duration:550,essential:true});else if(force){const pts=[p,d,tow].filter(Boolean) as Point[];if(pts.length>1){const b=new maplibregl.LngLatBounds();pts.forEach(x=>b.extend([x.lng,x.lat]));map.fitBounds(b,{padding:{top:160,bottom:220,left:42,right:42},maxZoom:15.2,pitch:assigned?42:18,duration:800,essential:true})}else if(pts[0])map.easeTo({center:[pts[0].lng,pts[0].lat],zoom:14,pitch:assigned?42:18,duration:500,essential:true})}}

  function recenter(){setFollowing(true);if(mapRef.current&&live)mapRef.current.easeTo({center:[live.lng,live.lat],zoom:15.5,pitch:assigned?50:28,bearing:live.heading??mapRef.current.getBearing(),duration:550,essential:true})}

  const distanceMiles=typeof route?.distance==='number'?route.distance/1609.344:Number(spatial?.route_context?.distanceMiles);
  const etaMinutes=typeof route?.duration==='number'?route.duration/60:Number(spatial?.route_context?.etaMinutes);
  const goingToPickup=Boolean(dispatchStatus&&PICKUP_STATES.has(dispatchStatus));
  const instruction=stepLabel(nextStep(route,live))||(assigned?(goingToPickup?'Proceed to pickup':'Proceed to destination'):'Position live');

  return <section className="map-panel dispatch-context"><div className="map-head"><div><span className="eyebrow map-eyebrow">ROVIQ Local · Tow</span><h2>{assigned?(goingToPickup?'Tow → pickup':'Vehicle → destination'):'Tow live map'}</h2><p>{assigned?'Live GPS navigation on the canonical ROVIQ Local map substrate.':'The live map stays available before a dispatch is assigned.'}</p></div><span className={`live-badge ${tracking}`}>{tracking==='live'?'● GPS LIVE':tracking==='starting'?'LOCATING…':'GPS LIMITED'}</span></div><div className={`live-map-wrap rq-local-${mode}`}><div ref={mapNode} className="live-map"/><div className="rq-brand rq-tow-brand"><strong>ROVIQ</strong><span>LOCAL · TOW</span></div><div className="rq-weather rq-tow-mode" aria-hidden="true"><span>{mode==='day'?'☀':'☾'}</span><span>{mode.toUpperCase()}</span></div>{assigned&&<section className="rq-nav-hud"><div className="rq-nav-kicker">ROVIQ DRIVE</div><div className="rq-nav-next">{instruction}</div><div className="rq-nav-meta"><strong>{Number.isFinite(etaMinutes)?`${Math.max(1,Math.round(etaMinutes))} min`:'—'}</strong><span>{Number.isFinite(distanceMiles)?`${distanceMiles.toFixed(1)} mi`:'—'}</span><span>{live?.speed!=null?`${Math.max(0,Math.round(live.speed*2.23694))} mph`:'0 mph'}</span></div><button type="button" className="rq-nav-follow" onClick={recenter} aria-label="Follow tow location">◎</button></section>}{!assigned&&<button type="button" className="rq-locate rq-map-locate" onClick={recenter} aria-label="Center on tow location">◎</button>}{error&&<div className="map-warning">{error}</div>}</div>{assigned&&<div className="spatial-grid"><div><span>Pickup</span><strong>{label(spatial?.origin??spatial?.current_vehicle)}</strong></div><div><span>Destination</span><strong>{label(spatial?.destination)}</strong></div><div><span>Tow position</span><strong>{label(live??spatial?.transport_location)}</strong></div><div><span>Current leg</span><strong>{goingToPickup?'Tow → pickup':'Vehicle → destination'}</strong></div><div><span>Distance</span><strong>{Number.isFinite(distanceMiles)?`${distanceMiles.toFixed(1)} mi`:'—'}</strong></div><div><span>ETA</span><strong>{Number.isFinite(etaMinutes)?`${Math.max(1,Math.round(etaMinutes))} min`:'—'}</strong></div></div>}</section>;
}
