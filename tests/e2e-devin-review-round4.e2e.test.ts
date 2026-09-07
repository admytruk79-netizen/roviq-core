import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createShopWaitlistEntry } from '../src/services/shop-os-waitlist.js';

const ADMIN_KEY=process.env.ADMIN_API_KEY!;
const adminHeaders=()=>({'x-roviq-role':'admin','x-admin-api-key':ADMIN_KEY});
const globalAdmin={role:'admin'} as const;

async function organization(){
  return (await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Waitlist validation ${Date.now()}-${Math.random()}`
  ])).rows[0].id as string;
}

describe('Devin review round 4 regressions',()=>{
  let app:FastifyInstance;
  beforeAll(async()=>{
    app=await buildApp();
    app.get('/__test/deferred-booking-conflict',{config:{public:true}},async()=>{
      throw Object.assign(new Error('deferred_service_appointment_case_mismatch'),{code:'23514'});
    });
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('rejects noncanonical waitlist resource preferences at the HTTP boundary',async()=>{
    const organizationId=await organization();
    const response=await app.inject({
      method:'POST',
      url:'/api/shop-os/waitlist',
      headers:adminHeaders(),
      payload:{organizationId,preferredResourceTypes:['Bay']}
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('validation_error');
  });

  it('rejects noncanonical waitlist resource preferences in the service layer too',async()=>{
    const organizationId=await organization();
    await expect(createShopWaitlistEntry(globalAdmin,{
      organizationId,
      preferredResourceTypes:['spaceship'] as any
    })).rejects.toMatchObject({message:'preferred_resource_type_invalid',statusCode:400});
  });

  it('maps deferred-service database integrity conflicts to a client conflict response',async()=>{
    const response=await app.inject({method:'GET',url:'/__test/deferred-booking-conflict'});
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({error:'deferred_service_appointment_case_mismatch'});
  });
});
