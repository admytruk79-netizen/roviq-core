import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY=process.env.ADMIN_API_KEY!;
const adminHeaders=()=>({'x-roviq-role':'admin','x-admin-api-key':ADMIN_KEY});
const actorHeaders=(role:string,actorId:string)=>({'x-roviq-role':role,'x-roviq-actor-id':actorId});

describe('transport spatial handoff',()=>{
  let app:FastifyInstance;
  beforeAll(async()=>{app=await buildApp();});
  afterAll(async()=>{await pool.end();});

  it('projects the canonical customer intake location into a Tow assignment when the dispatch omits pickup coordinates',async()=>{
    const customerRes=await app.inject({method:'POST',url:'/api/admin/actors',headers:adminHeaders(),payload:{actorType:'customer'}});
    const customerId=JSON.parse(customerRes.body).actor.id as string;
    const towRes=await app.inject({method:'POST',url:'/api/admin/actors',headers:adminHeaders(),payload:{actorType:'tow'}});
    const towId=JSON.parse(towRes.body).actor.id as string;

    const demandRes=await app.inject({
      method:'POST',url:'/api/demands',headers:actorHeaders('customer',customerId),
      payload:{domain:'maintenance',demandType:'wont_start',urgency:'urgent',location:{lat:45.5231,lng:-122.6765}}
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId=JSON.parse(demandRes.body).case.id as string;

    await app.inject({method:'POST',url:`/api/maintenance/cases/${caseId}/transition`,headers:adminHeaders(),payload:{toState:'tow_pending'}});

    const dispatchRes=await app.inject({
      method:'POST',url:'/api/admin/transport',headers:adminHeaders(),
      payload:{caseId,transportType:'tow'}
    });
    expect(dispatchRes.statusCode).toBe(201);
    const dispatch=JSON.parse(dispatchRes.body).dispatch;
    expect(dispatch.pickup_location).toMatchObject({lat:45.5231,lng:-122.6765});

    const assignRes=await app.inject({
      method:'POST',url:`/api/admin/transport/${dispatch.id}/assign`,headers:adminHeaders(),payload:{providerActorId:towId}
    });
    expect(assignRes.statusCode).toBe(200);

    const mine=await app.inject({method:'GET',url:'/api/transport/me/dispatches',headers:actorHeaders('tow',towId)});
    expect(mine.statusCode).toBe(200);
    const projected=JSON.parse(mine.body).dispatches.find((item:{id:string})=>item.id===dispatch.id);
    expect(projected.pickup_location).toMatchObject({lat:45.5231,lng:-122.6765});
    expect(projected.location_status).toBe('pickup_ready');

    const detail=await app.inject({method:'GET',url:`/api/transport/${dispatch.id}`,headers:actorHeaders('tow',towId)});
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).dispatch.pickup_location).toMatchObject({lat:45.5231,lng:-122.6765});
  });
});
