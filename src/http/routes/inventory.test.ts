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
      expect(query.mock.calls[0][1]).toEqual(['F-250','Ford',null,null,null,5,10]);
      expect(query.mock.calls[1][1]).toEqual(['F-250','Ford',null,null,null]);
      expect(query.mock.calls[0][0].split('where ')[1].split('order by')[0].trim())
        .toBe(query.mock.calls[1][0].split('where ')[1].trim());
      expect(query.mock.calls[0][0]).toContain("last_seen_at >= now() - interval '24 hours'");
    }finally{await app.close();query.mockClear()}
  });
});
