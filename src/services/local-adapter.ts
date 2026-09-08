type LocalPoint={lat:number;lng:number};

type LocalAdapterOptions={signal?:AbortSignal};

const DEFAULT_LOCAL_BASE='https://roviq-local2.admytruk79.workers.dev';

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

function baseUrl(){
  return (process.env.ROVIQ_LOCAL_BASE_URL??DEFAULT_LOCAL_BASE).replace(/\/$/,'');
}

function assertPoint(point:LocalPoint){
  if(!Number.isFinite(point.lat)||!Number.isFinite(point.lng)||Math.abs(point.lat)>90||Math.abs(point.lng)>180){
    throw httpError('local_coordinates_invalid',400);
  }
}

async function localFetch<T>(path:string,options:LocalAdapterOptions={}):Promise<T>{
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5000);
  const signal=options.signal??controller.signal;
  try{
    const response=await fetch(`${baseUrl()}${path}`,{headers:{accept:'application/json'},signal});
    const body=await response.json().catch(()=>null) as T|null;
    if(!response.ok){
      const upstream=(body as {error?:string}|null)?.error;
      throw httpError(upstream?`local_upstream_${String(upstream).toLowerCase().replace(/[^a-z0-9]+/g,'_')}`:'local_upstream_error',response.status>=400&&response.status<500?response.status:502);
    }
    if(body===null) throw httpError('local_upstream_invalid_response',502);
    return body;
  }catch(error){
    if(error instanceof Error&&(error as Error&{statusCode?:number}).statusCode) throw error;
    if(error instanceof Error&&error.name==='AbortError') throw httpError('local_upstream_timeout',504);
    throw httpError('local_upstream_unavailable',502);
  }finally{clearTimeout(timeout);}
}

export async function getLocalRoute(from:LocalPoint,to:LocalPoint,options:LocalAdapterOptions={}){
  assertPoint(from);assertPoint(to);
  const params=new URLSearchParams({from:`${from.lng},${from.lat}`,to:`${to.lng},${to.lat}`});
  return localFetch<{route:{geometry:{type:string;coordinates:number[][]};distance:number;duration:number;steps:unknown[]}}>(`/api/route?${params}`,options);
}

export async function discoverLocalPlaces(input:{
  lat?:number;lng?:number;radiusKm?:number;category?:string;city?:string;market?:string;countryCode?:string;
},options:LocalAdapterOptions={}){
  if((input.lat===undefined)!==(input.lng===undefined)) throw httpError('local_coordinates_incomplete',400);
  if(input.lat!==undefined&&input.lng!==undefined) assertPoint({lat:input.lat,lng:input.lng});
  const params=new URLSearchParams();
  if(input.lat!==undefined)params.set('lat',String(input.lat));
  if(input.lng!==undefined)params.set('lng',String(input.lng));
  if(input.radiusKm!==undefined)params.set('radius_km',String(input.radiusKm));
  if(input.category)params.set('category',input.category);
  if(input.city)params.set('city',input.city);
  if(input.market)params.set('market',input.market);
  if(input.countryCode)params.set('country_code',input.countryCode);
  params.set('status','approved');
  return localFetch<{success:boolean;scope:unknown;places:unknown[]}>(`/api/places?${params}`,options);
}

export async function getLocalHealth(options:LocalAdapterOptions={}){
  return localFetch<Record<string,unknown>>('/api/health',options);
}
