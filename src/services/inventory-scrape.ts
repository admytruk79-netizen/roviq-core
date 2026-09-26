import { pool } from '../db/pool.js';
import { DEFAULT_DEALER_SOURCES, matchesSource, rejectionReason, scrapeDealer, sourceCondition, type DealerSource, type Fetcher } from './dealer-scrapers.js';
import { DEFAULT_MARKUP_BPS, retireSourceInventory, syncInventoryFeed } from './inventory-sync.js';

export type DealerScrapeResult={sourceKey:string;dealer:string;ok:boolean;scraped:number;matched:number;removed?:number;rejected?:Record<string,number>;error?:string};
export type InventoryScrapeRun={startedAt:string;finishedAt:string;markupBps:number;results:DealerScrapeResult[]};

let lastRun:InventoryScrapeRun|undefined;
export const lastInventoryScrape=()=>lastRun;

export function dealerSourcesFromEnv(raw=process.env.INVENTORY_DEALER_SOURCES):DealerSource[]{
  if(!raw?.trim()) return DEFAULT_DEALER_SOURCES;
  const parsed=JSON.parse(raw);
  if(!Array.isArray(parsed)||!parsed.every(s=>s?.key&&s?.name&&s?.baseUrl&&s?.platform)) throw new Error('invalid_INVENTORY_DEALER_SOURCES');
  return parsed;
}

export function markupBpsFromEnv(raw=process.env.INVENTORY_MARKUP_PERCENT){
  if(!raw?.trim()) return DEFAULT_MARKUP_BPS;
  const bps=Math.round(Number(raw)*100);
  if(!Number.isInteger(bps)||bps<0||bps>10000) throw new Error('invalid_INVENTORY_MARKUP_PERCENT');
  return bps;
}

// Scrape each dealer, keep only the target trucks and publish them with the markup.
// A dealer whose scrape fails is left untouched; its listings drop off the public
// site once they are older than the freshness window.
export async function runInventoryScrape(opts:{sources?:DealerSource[];markupBps?:number;fetcher?:Fetcher}={}):Promise<InventoryScrapeRun>{
  const startedAt=new Date().toISOString();
  const sources=opts.sources??dealerSourcesFromEnv();
  const markupBps=opts.markupBps??markupBpsFromEnv();
  const results:DealerScrapeResult[]=[];
  for(const source of sources){
    try{
      const scraped=await scrapeDealer(source,opts.fetcher);
      if(!scraped.length) throw new Error('dealer_inventory_empty_or_unrecognized');
      const seen=new Set<string>();
      const condition=sourceCondition(source);
      const matches=scraped.filter(v=>v.id&&v.make&&v.model&&matchesSource(v,source)&&!seen.has(v.id)&&seen.add(v.id))
        .map(v=>({...v,condition}));
      const rejected:Record<string,number>={};
      for(const v of scraped){const reason=rejectionReason(v,source);if(reason) rejected[reason]=(rejected[reason]??0)+1}
      if(matches.length){
        await syncInventoryFeed(source.key,matches,0,true,markupBps);
        results.push({sourceKey:source.key,dealer:source.name,ok:true,scraped:scraped.length,matched:matches.length,rejected});
      }else{
        const removed=await retireSourceInventory(source.key);
        results.push({sourceKey:source.key,dealer:source.name,ok:true,scraped:scraped.length,matched:0,removed,rejected});
      }
    }catch(e){
      results.push({sourceKey:source.key,dealer:source.name,ok:false,scraped:0,matched:0,error:String((e as Error)?.message??e)});
    }
  }
  lastRun={startedAt,finishedAt:new Date().toISOString(),markupBps,results};
  return lastRun;
}

// Advisory lock so overlapping timers or instances never scrape concurrently.
const LOCK_KEY=780_850;
export async function runInventoryScrapeLocked(opts?:Parameters<typeof runInventoryScrape>[0]){
  const client=await pool.connect();
  try{
    const lock=await client.query<{locked:boolean}>('select pg_try_advisory_lock($1) as locked',[LOCK_KEY]);
    if(!lock.rows[0]?.locked) return undefined;
    try{return await runInventoryScrape(opts)}
    finally{await client.query('select pg_advisory_unlock($1)',[LOCK_KEY])}
  }finally{client.release()}
}

export function startInventoryScrapeScheduler(minutes=Number(process.env.INVENTORY_SCRAPE_INTERVAL_MINUTES??'20')){
  if(!Number.isFinite(minutes)||minutes<=0) return undefined;
  const tick=()=>runInventoryScrapeLocked().then(run=>{
    if(run) console.log(JSON.stringify({event:'inventory_scrape_complete',...run}));
  }).catch(e=>console.error(JSON.stringify({event:'inventory_scrape_failed',error:String(e?.message??e)})));
  const first=setTimeout(tick,15_000);
  const timer=setInterval(tick,Math.max(5,minutes)*60_000);
  first.unref();timer.unref();
  return ()=>{clearTimeout(first);clearInterval(timer)};
}
