import type { InventoryFeedVehicle } from './inventory-sync.js';

// Dealer website inventory scrapers. Each dealer platform exposes the same
// JSON its own search page loads, so we read that instead of parsing HTML,
// and fall back to schema.org JSON-LD embedded in the listing page.

export type DealerPlatform='dealer.com'|'dealer-inspire'|'json-ld';
export type VehicleCondition='new'|'used';
export type DealerSource={
  key:string;name:string;baseUrl:string;platform:DealerPlatform;
  // Which side of the lot to scrape; defaults to used.
  condition?:VehicleCondition;
  // Optional overrides when a platform's settings can't be read from the page.
  listingPath?:string;algoliaAppId?:string;algoliaApiKey?:string;algoliaIndex?:string;
};

export const DEFAULT_DEALER_SOURCES:DealerSource[]=[
  {key:'carr-chevrolet-beaverton',name:'Carr Chevrolet',baseUrl:'https://www.carrchevrolet.com',platform:'dealer.com'},
  {key:'damerow-ford-beaverton',name:'Damerow Ford',baseUrl:'https://www.damerowford.com',platform:'dealer-inspire',listingPath:'/inventory/used-vehicles/'},
  {key:'kendall-ford-eugene-new',name:'Kendall Ford of Eugene',baseUrl:'https://www.kendallford.com',platform:'dealer.com',condition:'new'},
  {key:'kendall-ford-bend-new',name:'Kendall Ford of Bend',baseUrl:'https://www.kendallfordbend.com',platform:'dealer.com',condition:'new'}
];

export const sourceCondition=(source:DealerSource):VehicleCondition=>source.condition??'used';

export const MAX_MILEAGE=50_000;

export type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;

const HEADERS={
  'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  accept:'application/json,text/html;q=0.9,*/*;q=0.8'
};

function text(v:unknown):string|undefined{
  if(typeof v==='string'&&v.trim()) return v.trim();
  if(typeof v==='number'&&Number.isFinite(v)) return String(v);
  return undefined;
}
export function parseNumber(v:unknown):number|undefined{
  if(typeof v==='number') return Number.isFinite(v)?v:undefined;
  if(typeof v!=='string') return undefined;
  const m=v.replace(/,/g,'').match(/-?\d+(\.\d+)?/);
  return m?Number(m[0]):undefined;
}
function dollarsToCents(v:unknown){
  const n=parseNumber(v);
  return n&&n>0?Math.round(n*100):undefined;
}
function absoluteUrl(base:string,href:unknown){
  const h=text(href);
  if(!h) return undefined;
  try{return new URL(h,base).toString()}catch{return undefined}
}
function stringList(v:unknown,base:string):string[]{
  const items=Array.isArray(v)?v:v?[v]:[];
  return items.map(i=>absoluteUrl(base,typeof i==='string'?i:(i as any)?.uri??(i as any)?.url??(i as any)?.src))
    .filter((u):u is string=>Boolean(u));
}

// Failed responses keep a short, single-line excerpt so scrape logs show what the dealer sent back.
const excerpt=(body:string)=>body.replace(/\s+/g,' ').trim().slice(0,160);
async function getJson(fetcher:Fetcher,url:string,init?:RequestInit){
  const res=await fetcher(url,{...init,headers:{...HEADERS,...(init?.headers??{})}});
  const body=await res.text();
  if(!res.ok) throw new Error(`dealer_fetch_failed:${res.status}:${url}:${excerpt(body)}`);
  try{return JSON.parse(body)}catch{throw new Error(`dealer_response_not_json:${url}:${excerpt(body)}`)}
}
async function getText(fetcher:Fetcher,url:string){
  const res=await fetcher(url,{headers:HEADERS});
  const body=await res.text();
  if(!res.ok) throw new Error(`dealer_fetch_failed:${res.status}:${url}:${excerpt(body)}`);
  return body;
}

// ---------- Dealer.com (Cox Automotive) ----------

function attribute(item:any,...names:string[]){
  for(const list of [item?.attributes,item?.trackingAttributes]){
    if(!Array.isArray(list)) continue;
    const hit=list.find((a:any)=>names.includes(a?.name));
    if(hit) return hit.normalizedValue??hit.value;
  }
  return undefined;
}

export function mapDealerComVehicle(item:any,source:DealerSource):InventoryFeedVehicle{
  const dprice=Array.isArray(item?.pricing?.dprice)?item.pricing.dprice:[];
  const finalPrice=dprice.find((p:any)=>p?.isFinalPrice)??dprice[dprice.length-1];
  const priceCents=dollarsToCents(finalPrice?.value)??dollarsToCents(item?.pricing?.retailPrice)
    ??dollarsToCents(item?.trackingPricing?.internetPrice)??dollarsToCents(item?.trackingPricing?.salePrice);
  const title=Array.isArray(item?.title)?item.title.join(' '):text(item?.title);
  return {
    id:String(item?.uuid??item?.vin??item?.stockNumber??''),
    vin:text(item?.vin),year:parseNumber(item?.year),make:text(item?.make)??'',model:text(item?.model)??'',
    trim:text(item?.trim),
    mileage:parseNumber(item?.odometer??attribute(item,'odometer','mileage')),
    exteriorColor:text(item?.exteriorColor??attribute(item,'exteriorColor')),
    drivetrain:text(item?.driveLine??attribute(item,'driveLine','drivetrain')),
    fuelType:text(item?.fuelType??attribute(item,'fuelType')),
    bodyStyle:text(item?.bodyStyle??attribute(item,'bodyStyle')),
    images:stringList(item?.images,source.baseUrl),
    priceCents,
    dealerName:source.name,dealerUrl:absoluteUrl(source.baseUrl,item?.link),
    raw:{condition:text(item?.type??item?.condition)??sourceCondition(source),title,cab:text(attribute(item,'cab','cabType')),stockNumber:text(item?.stockNumber)}
  };
}

// Dealer.com sites serve inventory from one of two JSON endpoints depending on
// the site generation: the legacy widget GET and the newer ws-inv-data POST,
// which needs the site id from the listing page. Try both, then JSON-LD.
export function extractDealerComSite(html:string){
  const siteId=html.match(/["']siteId["']\s*:\s*["']([A-Za-z0-9_-]+)["']/)?.[1]
    ??html.match(/data-site-id=["']([A-Za-z0-9_-]+)["']/)?.[1];
  const pageId=html.match(/["']pageId["']\s*:\s*["']([A-Za-z0-9_-]+)["']/)?.[1];
  return siteId?{siteId,pageId}:undefined;
}

async function pageThrough(fetchPage:(start:number,pageSize:number)=>Promise<any>,source:DealerSource){
  const pageSize=100;
  const vehicles:InventoryFeedVehicle[]=[];
  // Sites may cap the page size below what we ask for, so advance by what came
  // back and stop on the reported total rather than on a short page.
  for(let start=0,page=0;page<60;page++){
    const body=await fetchPage(start,pageSize);
    const items:any[]=Array.isArray(body?.inventory)?body.inventory:[];
    vehicles.push(...items.map(i=>mapDealerComVehicle(i,source)));
    start+=items.length;
    const total=parseNumber(body?.pageInfo?.totalCount);
    if(!items.length||(total!==undefined?start>=total:items.length<pageSize)) break;
  }
  return vehicles;
}

async function scrapeDealerCom(source:DealerSource,fetcher:Fetcher){
  const kind=sourceCondition(source)==='new'?'NEW':'USED';
  const alias=`INVENTORY_LISTING_DEFAULT_AUTO_${kind}`;
  const attempts:string[]=[];
  try{
    const legacy=await pageThrough((start,size)=>getJson(fetcher,
      `${source.baseUrl}/apis/widget/${alias}:inventory-data-bus1/getInventory?start=${start}&pageSize=${size}`),source);
    if(legacy.length) return legacy;
    attempts.push('widget_api_empty');
  }catch(e){attempts.push(String((e as Error).message))}

  const listingUrl=new URL(source.listingPath??`/${kind.toLowerCase()}-inventory/index.htm`,source.baseUrl).toString();
  const html=await getText(fetcher,listingUrl);
  const site=extractDealerComSite(html);
  if(site){
    try{
      const current=await pageThrough((start,size)=>getJson(fetcher,`${source.baseUrl}/api/widget/ws-inv-data/getInventory`,{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          siteId:site.siteId,locale:'en_US',device:'DESKTOP',pageAlias:alias,
          pageId:site.pageId??`${site.siteId}_SITEBUILDER_INVENTORY_SEARCH_RESULTS_AUTO_${kind}_V1_1`,
          widgetName:'ws-inv-data',inventoryParameters:{start:String(start)},
          preferences:{pageSize:String(size)},includePricing:true
        })
      }),source);
      if(current.length) return current;
      attempts.push('ws_inv_data_empty');
    }catch(e){attempts.push(String((e as Error).message))}
  }else attempts.push('site_id_not_found');

  const fromPage=jsonLdVehicles(html,source);
  if(fromPage.length) return fromPage;
  throw new Error(`dealer_inventory_empty_or_unrecognized:${attempts.join(' | ')}`);
}

// ---------- Dealer Inspire (Algolia-backed search) ----------

export function extractAlgoliaConfig(html:string){
  const pick=(patterns:RegExp[])=>{for(const p of patterns){const m=html.match(p);if(m) return m[1]}return undefined};
  const appId=pick([
    /["']?(?:algolia_?app_?id|app_?id|applicationId|appId)["']?\s*[:=]\s*["']([A-Z0-9]{10})["']/i,
    /https:\/\/([A-Z0-9]{10})-dsn\.algolia\.net/i
  ])?.toUpperCase();
  const apiKey=pick([/["']?(?:algolia_?search_?api_?key|search_?api_?key|api_?key_?search|apiKey|api_key)["']?\s*[:=]\s*["']([a-f0-9]{32})["']/i]);
  const index=pick([
    /["']?(?:inventory_?index(?:_?name)?|index_?name|indexName)["']?\s*[:=]\s*["']([A-Za-z0-9_\-]+)["']/i,
    /["']([a-z0-9_\-]+_production_inventory[a-z0-9_\-]*)["']/i
  ]);
  return appId&&apiKey&&index?{appId,apiKey,index}:undefined;
}

export function mapDealerInspireHit(hit:any,source:DealerSource):InventoryFeedVehicle{
  const images=[...stringList(hit?.photo_urls??hit?.images,source.baseUrl),...stringList(hit?.thumbnail,source.baseUrl)];
  return {
    id:String(hit?.objectID??hit?.vin??hit?.stock??''),
    vin:text(hit?.vin),year:parseNumber(hit?.year),make:text(hit?.make)??'',model:text(hit?.model)??'',
    trim:text(hit?.trim),mileage:parseNumber(hit?.miles??hit?.mileage??hit?.odometer),
    exteriorColor:text(hit?.ext_color??hit?.exterior_color),drivetrain:text(hit?.drivetrain),
    fuelType:text(hit?.fuel_type),bodyStyle:text(hit?.body??hit?.body_style),
    images:[...new Set(images)],
    priceCents:dollarsToCents(hit?.our_price)??dollarsToCents(hit?.sale_price)??dollarsToCents(hit?.internet_price)??dollarsToCents(hit?.price),
    dealerName:source.name,dealerUrl:absoluteUrl(source.baseUrl,hit?.link),
    raw:{condition:text(hit?.type??hit?.condition)??'',title:text(hit?.title),cab:text(hit?.cab??hit?.cab_type??hit?.cab_style),stockNumber:text(hit?.stock)}
  };
}

async function scrapeDealerInspire(source:DealerSource,fetcher:Fetcher){
  let cfg=source.algoliaAppId&&source.algoliaApiKey&&source.algoliaIndex
    ?{appId:source.algoliaAppId,apiKey:source.algoliaApiKey,index:source.algoliaIndex}:undefined;
  if(!cfg){
    const html=await getText(fetcher,new URL(source.listingPath??'/inventory/used-vehicles/',source.baseUrl).toString());
    cfg=extractAlgoliaConfig(html);
    if(!cfg) return jsonLdVehicles(html,source);
  }
  const vehicles:InventoryFeedVehicle[]=[];
  for(let page=0;page<30;page++){
    const body=await getJson(fetcher,`https://${cfg.appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(cfg.index)}/query`,{
      method:'POST',
      headers:{'content-type':'application/json','x-algolia-application-id':cfg.appId,'x-algolia-api-key':cfg.apiKey},
      body:JSON.stringify({params:`query=&hitsPerPage=500&page=${page}`})
    });
    const hits:any[]=Array.isArray(body?.hits)?body.hits:[];
    vehicles.push(...hits.map(h=>mapDealerInspireHit(h,source)));
    const pages=parseNumber(body?.nbPages)??1;
    if(!hits.length||page+1>=pages) return vehicles;
  }
  return vehicles;
}

// ---------- schema.org JSON-LD fallback ----------

export function jsonLdVehicles(html:string,source:DealerSource):InventoryFeedVehicle[]{
  const out:InventoryFeedVehicle[]=[];
  const blocks=html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const visit=(node:any)=>{
    if(!node||typeof node!=='object') return;
    if(Array.isArray(node)){node.forEach(visit);return}
    if(node['@graph']) visit(node['@graph']);
    if(node.itemListElement) visit(node.itemListElement.map((e:any)=>e?.item??e));
    const types=[].concat(node['@type']??[]).map(String);
    if(!types.some(t=>/^(Vehicle|Car|Product|MotorizedBicycle)$/i.test(t))) return;
    const offer=Array.isArray(node.offers)?node.offers[0]:node.offers;
    const vin=text(node.vehicleIdentificationNumber??node.sku);
    out.push({
      id:String(vin??node.url??node['@id']??''),vin,
      year:parseNumber(node.vehicleModelDate??node.modelDate??node.productionDate),
      make:text(node.brand?.name??node.brand??node.manufacturer?.name)??'',model:text(node.model?.name??node.model)??'',
      trim:text(node.vehicleConfiguration),mileage:parseNumber(node.mileageFromOdometer?.value??node.mileageFromOdometer),
      exteriorColor:text(node.color),drivetrain:text(node.driveWheelConfiguration),fuelType:text(node.fuelType),
      bodyStyle:text(node.bodyType),images:stringList(node.image,source.baseUrl),
      priceCents:dollarsToCents(offer?.price),dealerName:source.name,dealerUrl:absoluteUrl(source.baseUrl,node.url??offer?.url),
      raw:{condition:text(node.itemCondition??offer?.itemCondition)??sourceCondition(source),title:text(node.name)}
    });
  };
  for(const [,json] of blocks){
    try{visit(JSON.parse(json))}catch{/* skip malformed block */}
  }
  return out;
}

async function scrapeJsonLd(source:DealerSource,fetcher:Fetcher){
  return jsonLdVehicles(await getText(fetcher,new URL(source.listingPath??'/',source.baseUrl).toString()),source);
}

export async function scrapeDealer(source:DealerSource,fetcher:Fetcher=fetch){
  if(source.platform==='dealer.com') return scrapeDealerCom(source,fetcher);
  if(source.platform==='dealer-inspire') return scrapeDealerInspire(source,fetcher);
  return scrapeJsonLd(source,fetcher);
}

// ---------- Target filter: used, < 50k miles, crew-cab full-size pickups ----------

const TARGET_MODELS:{label:string;make:RegExp;model:RegExp}[]=[
  {label:'Ford F-150',make:/^ford$/i,model:/\bf-?150\b/i},
  {label:'Ford F-250',make:/^ford$/i,model:/\bf-?250\b/i},
  {label:'Chevrolet Silverado 1500',make:/^(chevrolet|chevy)$/i,model:/silverado\s*1500/i},
  {label:'Chevrolet Silverado 2500',make:/^(chevrolet|chevy)$/i,model:/silverado\s*2500/i},
  {label:'GMC Sierra 1500',make:/^gmc$/i,model:/sierra\s*1500/i},
  {label:'GMC Sierra 2500',make:/^gmc$/i,model:/sierra\s*2500/i}
];

function descriptor(v:InventoryFeedVehicle){
  const raw=v.raw??{};
  return [v.model,v.trim,v.bodyStyle,raw.title,raw.cab].filter(Boolean).join(' ');
}

export function targetModel(v:InventoryFeedVehicle){
  const text=`${v.model} ${v.trim??''} ${v.raw?.title??''}`;
  return TARGET_MODELS.find(t=>t.make.test(v.make.trim())&&t.model.test(text))?.label;
}

export function isCrewCab(v:InventoryFeedVehicle){
  const d=descriptor(v).toLowerCase();
  if(/\b(regular|reg\.?|single|standard|double|extended|ext\.?)\s*cab\b|\bsuper\s*cab\b/.test(d)) return false;
  return /\bsuper\s*crew\b|\bcrew\s*cab\b|\bcrewcab\b|\bcrew\b/.test(d);
}

export function isUsed(v:InventoryFeedVehicle){
  const condition=String(v.raw?.condition??'').toLowerCase();
  if(/\bnew\b/.test(condition)&&!/pre-?owned|used|certified/.test(condition)) return false;
  if(/used|pre-?owned|certified|cpo/.test(condition)) return true;
  // Unknown condition: a truck with delivery miles is almost certainly new.
  return (v.mileage??0)>=100;
}

export function isTargetTruck(v:InventoryFeedVehicle){
  return v.mileage!==undefined&&v.mileage<=MAX_MILEAGE&&isUsed(v)&&Boolean(targetModel(v))&&isCrewCab(v);
}

// New trucks: every F-150 and F-250 variant (XLT, Lariat, Tremor, Raptor,
// Lightning, King Ranch, Platinum...), but only crew cab / SuperCrew.
const NEW_TARGET_MODELS=new Set(['Ford F-150','Ford F-250']);
export function isTargetNewTruck(v:InventoryFeedVehicle){
  const model=targetModel(v);
  return !isUsed(v)&&Boolean(model&&NEW_TARGET_MODELS.has(model))&&isCrewCab(v);
}

// Why a scraped vehicle was not published, for the scrape log.
export function rejectionReason(v:InventoryFeedVehicle,source:DealerSource){
  const wantNew=sourceCondition(source)==='new';
  if(wantNew===isUsed(v)) return wantNew?'used':'new';
  if(!targetModel(v)||(wantNew&&!NEW_TARGET_MODELS.has(targetModel(v)!))) return 'model';
  if(!isCrewCab(v)) return 'cab';
  if(!wantNew&&v.mileage===undefined) return 'mileage_unknown';
  if(!wantNew&&v.mileage!>MAX_MILEAGE) return 'mileage_over';
  return undefined;
}

export function matchesSource(v:InventoryFeedVehicle,source:DealerSource){
  return sourceCondition(source)==='new'?isTargetNewTruck(v):isTargetTruck(v);
}
