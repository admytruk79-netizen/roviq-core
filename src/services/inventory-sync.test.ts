import {beforeEach,describe,expect,it,vi} from 'vitest';

const {queries,client}=vi.hoisted(()=>{
  const queries:{sql:string;params:unknown[]|undefined}[]=[];
  const client={query:vi.fn(async(sql:string,params?:unknown[])=>{
    queries.push({sql,params});
    return {rows:[],rowCount:0};
  }),release:vi.fn()};
  return {queries,client};
});
vi.mock('../db/pool.js',()=>({pool:{connect:vi.fn(async()=>client)}}));

import {syncInventoryFeed} from './inventory-sync.js';

const vehicle=(id:string)=>({id,make:'Ford',model:'F-150'});

describe('inventory feed integrity',()=>{
  beforeEach(()=>{queries.length=0;client.query.mockClear();client.release.mockClear()});

  it('does not remove other cars when a feed page arrives',async()=>{
    await syncInventoryFeed('dealer-a',[vehicle('first-page')]);
    await syncInventoryFeed('dealer-a',[vehicle('second-page')]);
    expect(queries.filter(q=>q.sql.includes("status='removed'"))).toHaveLength(0);
  });

  it('removes missing cars only for an explicitly complete snapshot',async()=>{
    await syncInventoryFeed('dealer-a',[vehicle('only-car')],0,true);
    const removal=queries.find(q=>q.sql.includes("status='removed'"));
    expect(removal?.params).toEqual(['dealer-a',['only-car']]);
  });

  it('uses each vehicle margin from the source feed',async()=>{
    await syncInventoryFeed('dealer-a',[{...vehicle('priced'),priceCents:3000000,marginCents:350000}],0);
    const insert=queries.find(q=>q.sql.includes('insert into vehicle_inventory'));
    expect(insert?.params?.[13]).toBe(3000000);
    expect(insert?.params?.[14]).toBe(350000);
    expect(insert?.params?.[18]).toBe(850);
  });

  it('stores the requested markup and rejects an invalid one',async()=>{
    await syncInventoryFeed('dealer-a',[vehicle('marked-up')],0,false,1000);
    expect(queries.find(q=>q.sql.includes('insert into vehicle_inventory'))?.params?.[18]).toBe(1000);
    await expect(syncInventoryFeed('dealer-a',[vehicle('bad')],0,false,-5)).rejects.toThrow('inventory_feed_invalid_markup');
  });

  it('rejects a duplicate or empty snapshot before opening a transaction',async()=>{
    await expect(syncInventoryFeed('dealer-a',[vehicle('same'),vehicle('same')],0,true)).rejects.toThrow('inventory_feed_invalid_or_duplicate');
    await expect(syncInventoryFeed('dealer-a',[],0,true)).rejects.toThrow('inventory_feed_empty');
    expect(queries).toHaveLength(0);
  });
});
