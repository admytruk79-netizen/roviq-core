import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY=process.env.ADMIN_API_KEY!;
const adminHeaders=()=>({'x-roviq-role':'admin','x-admin-api-key':ADMIN_KEY});
const actorHeaders=(role:string,actorId:string)=>({'x-roviq-role':role,'x-roviq-actor-id':actorId});

describe('Core dispatcher assignment offers',()=>{
  let app:FastifyInstance;
  beforeAll(async()=>{app=await buildApp();});
  afterAll(async()=>{await pool.end();});

  it('offers a Case to an actor and transfers ownership only after acceptance',async()=>{
    const partnerRes=await app.inject({
      method:'POST',url:'/api/admin/actors',headers:adminHeaders(),payload:{actorType:'partner'}
    });
    expect(partnerRes.statusCode).toBe(201);
    const partnerId=JSON.parse(partnerRes.body).actor.id as string;

    const createRes=await app.inject({
      method:'POST',url:'/api/core/cases',
      headers:{...adminHeaders(),'idempotency-key':crypto.randomUUID()},
      payload:{caseType:'maintenance',priority:'high',attributes:{test:'assignment-offer'}}
    });
    expect(createRes.statusCode).toBe(201);
    const created=JSON.parse(createRes.body).case;
    expect(created.current_owner_actor_id).toBeNull();
    expect(Number(created.version)).toBe(1);

    const offerRes=await app.inject({
      method:'POST',url:`/api/core/cases/${created.id}/assignment-offers`,
      headers:{...adminHeaders(),'idempotency-key':crypto.randomUUID()},
      payload:{actorId:partnerId,expectedVersion:1,reason:'Acceptance test',expiresInMinutes:15}
    });
    expect(offerRes.statusCode).toBe(201);
    const offer=JSON.parse(offerRes.body).offer;
    expect(offer.offered_to_actor_id).toBe(partnerId);
    expect(offer.state).toBe('pending');
    expect(Number(offer.expected_case_version)).toBe(2);

    const beforeAccept=await app.inject({method:'GET',url:'/api/core/me/cases',headers:actorHeaders('partner',partnerId)});
    expect(beforeAccept.statusCode).toBe(200);
    expect(JSON.parse(beforeAccept.body).cases.some((c:{id:string})=>c.id===created.id)).toBe(false);

    const mine=await app.inject({method:'GET',url:'/api/core/me/assignment-offers',headers:actorHeaders('partner',partnerId)});
    expect(mine.statusCode).toBe(200);
    expect(JSON.parse(mine.body).offers.some((o:{id:string})=>o.id===offer.id)).toBe(true);

    const accept=await app.inject({
      method:'POST',url:`/api/core/assignment-offers/${offer.id}/respond`,
      headers:{...actorHeaders('partner',partnerId),'idempotency-key':crypto.randomUUID()},
      payload:{decision:'accepted'}
    });
    expect(accept.statusCode).toBe(200);
    expect(JSON.parse(accept.body).ownerActorId).toBe(partnerId);

    const afterAccept=await app.inject({method:'GET',url:'/api/core/me/cases',headers:actorHeaders('partner',partnerId)});
    expect(afterAccept.statusCode).toBe(200);
    const owned=JSON.parse(afterAccept.body).cases.find((c:{id:string})=>c.id===created.id);
    expect(owned.current_owner_actor_id).toBe(partnerId);
    expect(Number(owned.version)).toBe(3);

    const events=await app.inject({method:'GET',url:`/api/core/cases/${created.id}`,headers:actorHeaders('partner',partnerId)});
    expect(events.statusCode).toBe(200);
    const types=JSON.parse(events.body).events.map((e:{event_type:string})=>e.event_type);
    expect(types).toContain('CASE_ASSIGNMENT_OFFERED');
    expect(types).toContain('CASE_ASSIGNMENT_ACCEPTED');
  });

  it('keeps ownership unchanged when an actor declines',async()=>{
    const towRes=await app.inject({method:'POST',url:'/api/admin/actors',headers:adminHeaders(),payload:{actorType:'tow'}});
    const towId=JSON.parse(towRes.body).actor.id as string;
    const createRes=await app.inject({
      method:'POST',url:'/api/core/cases',
      headers:{...adminHeaders(),'idempotency-key':crypto.randomUUID()},
      payload:{caseType:'transport',priority:'normal'}
    });
    const c=JSON.parse(createRes.body).case;
    const offerRes=await app.inject({
      method:'POST',url:`/api/core/cases/${c.id}/assignment-offers`,
      headers:{...adminHeaders(),'idempotency-key':crypto.randomUUID()},
      payload:{actorId:towId,expectedVersion:1}
    });
    const offer=JSON.parse(offerRes.body).offer;
    const decline=await app.inject({
      method:'POST',url:`/api/core/assignment-offers/${offer.id}/respond`,
      headers:{...actorHeaders('tow',towId),'idempotency-key':crypto.randomUUID()},
      payload:{decision:'declined',reason:'Unavailable'}
    });
    expect(decline.statusCode).toBe(200);
    expect(JSON.parse(decline.body).ownerActorId).toBeNull();
    const mine=await app.inject({method:'GET',url:'/api/core/me/cases',headers:actorHeaders('tow',towId)});
    expect(JSON.parse(mine.body).cases.some((x:{id:string})=>x.id===c.id)).toBe(false);
  });
});
