import Fastify from 'fastify';
import {describe,expect,it,vi} from 'vitest';

const {query}=vi.hoisted(()=>({query:vi.fn(async(sql:string,_params?:unknown[])=>
  sql.includes('count(*)')?{rows:[{count:1}]}:{rows:[{id:'match'}]})}));
vi.mock('../../db/pool.js',()=>({pool:{query}}));
vi.mock('../middleware/principal.js',()=>({requireRole:()=>async()=>{}}));
import {inventoryRoutes} from './inventory.js';

describe('public inventory search',()=>{
  it('counts only filtered results using the same parameters as the page',async()=>{
    const app=Fastify();
    await app.register(inventoryRoutes);
    try{
      const response=await app.inject('/api/inventory?q=F-250&make=Ford&limit=5&offset=10');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({total:1,inventory:[{id:'match'}]});
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[0][1]).toEqual(['F-250','Ford',null,null,null,null,null,null,5,10]);
      expect(query.mock.calls[1][1]).toEqual(['F-250','Ford',null,null,null,null,null,null]);
      expect(query.mock.calls[0][0].split('where ')[1].split('order by')[0].trim())
        .toBe(query.mock.calls[1][0].split('where ')[1].trim());
      expect(query.mock.calls[0][0]).toContain("last_seen_at >= now() - interval '24 hours'");
    }finally{await app.close();query.mockClear()}
  });

  it('applies mileage, price and sort filters and rejects unknown sorts',async()=>{
    const app=Fastify();
    await app.register(inventoryRoutes);
    try{
      const response=await app.inject('/api/inventory?maxMileage=50000&maxPriceCents=6000000&sort=price_asc&condition=new');
      expect(response.statusCode).toBe(200);
      expect(query.mock.calls[0][1]).toEqual([null,null,null,null,null,50000,6000000,'new',48,0]);
      expect(query.mock.calls[0][0]).toContain('order by public_price_cents asc nulls last');
      expect((await app.inject('/api/inventory?sort=drop%20table')).statusCode).not.toBe(200);
      expect(query).toHaveBeenCalledTimes(2);
    }finally{await app.close();query.mockClear()}
  });
});

describe('new trucks hidden until SHOW_NEW_TRUCKS=true',()=>{
  it('filters out new trucks by default and shows them when switched on',async()=>{
    const app=Fastify();
    await app.register(inventoryRoutes);
    const prev=process.env.SHOW_NEW_TRUCKS;
    try{
      delete process.env.SHOW_NEW_TRUCKS;
      const hidden=await app.inject('/api/inventory');
      expect(hidden.json().newTrucksShown).toBe(false);
      expect(query.mock.calls[0][0]).toContain("condition is distinct from 'new'");
      expect(query.mock.calls[1][0]).toContain("condition is distinct from 'new'");
      query.mockClear();
      process.env.SHOW_NEW_TRUCKS='true';
      const shown=await app.inject('/api/inventory');
      expect(shown.json().newTrucksShown).toBe(true);
      expect(query.mock.calls[0][0]).not.toContain("condition is distinct from 'new'");
    }finally{await app.close();query.mockClear();if(prev===undefined)delete process.env.SHOW_NEW_TRUCKS;else process.env.SHOW_NEW_TRUCKS=prev}
  });
});

describe('truck availability and requests',()=>{
  it('returns availability for a VIN without dealer details and rejects malformed VINs',async()=>{
    query.mockResolvedValueOnce({rows:[{id:'i',vin:'1FTEW2LP5TKE63673',year:2026,make:'Ford',model:'F-150',trim:'STX',condition:'new',
      public_price_cents:4894500,source_price_cents:4511100,source_dealer_name:'Courtesy Ford',source_dealer_url:'https://d',last_seen_at:'2026-09-27T06:00:00Z',available:true}]} as never);
    const app=Fastify();
    await app.register(inventoryRoutes);
    try{
      const ok=await app.inject('/api/inventory/vin/1FTEW2LP5TKE63673');
      expect(ok.json()).toMatchObject({found:true,available:true,priceCents:4894500,title:'2026 Ford F-150 STX'});
      expect(JSON.stringify(ok.json())).not.toMatch(/Courtesy|4511100|https:\/\/d/);
      expect((await app.inject('/api/inventory/vin/NOTAVIN')).statusCode).not.toBe(200);
    }finally{await app.close();query.mockReset()}
  });

  it('accepts a request and answers 429 when the sender is rate limited',async()=>{
    const app=Fastify();
    await app.register(inventoryRoutes);
    try{
      query.mockResolvedValueOnce({rows:[{count:0}]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'req'}]});
      const body={vin:'1FTEW2LP5TKE63673',name:'A',email:'a@example.com',clientIp:'203.0.113.5'};
      const created=await app.inject({method:'POST',url:'/api/inventory/inquiries',payload:body});
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({id:'req',available:false,ownerNotified:false});
      query.mockResolvedValueOnce({rows:[{count:5}]});
      expect((await app.inject({method:'POST',url:'/api/inventory/inquiries',payload:body})).statusCode).toBe(429);
      expect((await app.inject({method:'POST',url:'/api/inventory/inquiries',payload:{...body,email:'bad'}})).statusCode).not.toBe(201);
    }finally{await app.close();query.mockReset()}
  });
});

describe('site dealer lookup',()=>{
  const KEY='k'.repeat(32);
  it('is off without a configured key and rejects a wrong key',async()=>{
    const app=Fastify();
    await app.register(inventoryRoutes);
    const prev=process.env.SITE_DEALER_LOOKUP_KEY;
    try{
      delete process.env.SITE_DEALER_LOOKUP_KEY;
      const payload={vins:['1FTEW2LP5TKE63673']};
      expect((await app.inject({method:'POST',url:'/api/site/inventory/dealers',payload,headers:{'x-roviq-site-key':KEY}})).statusCode).toBe(503);
      process.env.SITE_DEALER_LOOKUP_KEY=KEY;
      expect((await app.inject({method:'POST',url:'/api/site/inventory/dealers',payload})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/site/inventory/dealers',payload,headers:{'x-roviq-site-key':'wrong'}})).statusCode).toBe(401);
      expect(query).not.toHaveBeenCalled();
    }finally{await app.close();query.mockReset();if(prev===undefined)delete process.env.SITE_DEALER_LOOKUP_KEY;else process.env.SITE_DEALER_LOOKUP_KEY=prev}
  });

  it('returns the current dealer, falling back to the snapshot kept with the request',async()=>{
    const app=Fastify();
    await app.register(inventoryRoutes);
    const prev=process.env.SITE_DEALER_LOOKUP_KEY;
    process.env.SITE_DEALER_LOOKUP_KEY=KEY;
    try{
      query
        .mockResolvedValueOnce({rows:[{vin:'1GTUUEE82TG498073',source_dealer_name:'Buick GMC of Beaverton',source_dealer_url:'https://gmc/v',
          source_price_cents:7499500,public_price_cents:8136958,last_seen_at:'2026-09-28T16:00:00Z',available:true}]} as never)
        .mockResolvedValueOnce({rows:[{vin:'1FTEW2LP5TKE63673',dealer_name:'Courtesy Ford (Portland)',dealer_url:'https://cf/v',
          source_price_cents:4511100,quoted_price_cents:4894500}]} as never);
      const res=await app.inject({method:'POST',url:'/api/site/inventory/dealers',headers:{'x-roviq-site-key':KEY},
        payload:{vins:['1gtuuee82tg498073','1FTEW2LP5TKE63673']}});
      expect(res.statusCode).toBe(200);
      expect(res.json().dealers).toMatchObject({
        '1GTUUEE82TG498073':{dealerName:'Buick GMC of Beaverton',dealerPriceCents:7499500,available:true,from:'inventory'},
        '1FTEW2LP5TKE63673':{dealerName:'Courtesy Ford (Portland)',dealerUrl:'https://cf/v',available:false,from:'request'}});
      expect(query.mock.calls[0][1]).toEqual([['1GTUUEE82TG498073','1FTEW2LP5TKE63673']]);
      expect((await app.inject({method:'POST',url:'/api/site/inventory/dealers',headers:{'x-roviq-site-key':KEY},payload:{vins:['bad']}})).statusCode).not.toBe(200);
    }finally{await app.close();query.mockReset();if(prev===undefined)delete process.env.SITE_DEALER_LOOKUP_KEY;else process.env.SITE_DEALER_LOOKUP_KEY=prev}
  });
});
