import {beforeEach,describe,expect,it,vi} from 'vitest';

const {sync,retire}=vi.hoisted(()=>({sync:vi.fn(async()=>({})),retire:vi.fn(async()=>2)}));
vi.mock('../db/pool.js',()=>({pool:{}}));
vi.mock('./inventory-sync.js',()=>({DEFAULT_MARKUP_BPS:850,syncInventoryFeed:sync,retireSourceInventory:retire}));
import {markupBpsFromEnv,runInventoryScrape} from './inventory-scrape.js';
import type {DealerSource} from './dealer-scrapers.js';

const source:DealerSource={key:'carr',name:'Carr Chevrolet',baseUrl:'https://www.carrchevrolet.com',platform:'dealer.com'};
const item=(uuid:string,o:Record<string,unknown>={})=>({uuid,type:'used',year:2022,make:'Chevrolet',model:'Silverado 1500',trim:'LT Crew Cab',
  odometer:'20,000',pricing:{retailPrice:'$40,000'},...o});
const feed=(items:unknown[])=>async()=>new Response(JSON.stringify({pageInfo:{totalCount:items.length},inventory:items}),{status:200});

describe('inventory scrape run',()=>{
  beforeEach(()=>{sync.mockClear();retire.mockClear()});

  it('publishes only matching trucks as a complete snapshot with the 8.5% markup',async()=>{
    const run=await runInventoryScrape({sources:[source],fetcher:feed([item('a'),item('b',{odometer:'75,000'}),item('c',{model:'Malibu'}),item('a')])});
    expect(run.results[0]).toMatchObject({ok:true,scraped:4,matched:1});
    expect(sync).toHaveBeenCalledWith('carr',[expect.objectContaining({id:'a',priceCents:4000000})],0,true,850);
  });

  it('retires a dealer when a full scrape has no matching trucks',async()=>{
    const run=await runInventoryScrape({sources:[source],fetcher:feed([item('x',{odometer:'90,000'})])});
    expect(sync).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledWith('carr');
    expect(run.results[0]).toMatchObject({ok:true,matched:0,removed:2});
  });

  it('leaves listings untouched when a dealer site fails',async()=>{
    const run=await runInventoryScrape({sources:[source],fetcher:async()=>new Response('blocked',{status:403})});
    expect(sync).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(run.results[0].ok).toBe(false);
  });

  it('reads the markup percent from the environment',()=>{
    expect(markupBpsFromEnv(undefined)).toBe(850);
    expect(markupBpsFromEnv('8.5')).toBe(850);
    expect(()=>markupBpsFromEnv('-1')).toThrow();
  });
});
