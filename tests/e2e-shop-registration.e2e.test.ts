import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const password='Shop-owner-12345!';
const admin={'x-roviq-role':'admin','x-admin-api-key':process.env.ADMIN_API_KEY!};
function fixture(){ const requestId=randomUUID(); return {requestId,businessName:`Self-service ${requestId}`,operatorName:'Shop owner',email:`${requestId}@example.test`,password,location:{name:'Main shop',address:'123 Test Street',city:'Portland',region:'OR',countryCode:'US'}}; }
describe('self-service shop registration',()=>{
  let app:FastifyInstance; let address=0;
  beforeAll(async()=>{app=await buildApp();});
  afterAll(async()=>{await app.close();await pool.end();});
  const register=(payload:Record<string,unknown>,remoteAddress=`192.0.2.${++address}`)=>app.inject({method:'POST',url:'/api/shops/register',remoteAddress,payload});
  const login=(email:string)=>app.inject({method:'POST',url:'/api/auth/login',payload:{email,password}});
  it('creates a scoped shop login and walk-in intake without granting network readiness',async()=>{
    const input=fixture(), response=await register(input);
    expect(response.statusCode).toBe(201);
    expect(response.json().business).toMatchObject({actorId:input.requestId,role:'partner',readiness:'configuration_required'});
    const session=await login(input.email); expect(session.statusCode).toBe(200);
    expect(session.json().roles).toEqual([{role:'partner',actorId:input.requestId,primary:true}]);
    const headers={authorization:`Bearer ${session.json().accessToken}`};
    expect((await app.inject({method:'GET',url:'/api/shop-os/repair-orders',headers})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/api/shop-os/local-intake',headers,payload:{displayName:'Walk-in customer',vehicle:{make:'Ford',model:'Focus',modelYear:2017}}})).statusCode).toBe(201);
    expect((await app.inject({method:'GET',url:'/api/admin/business-onboarding',headers})).statusCode).toBe(403);
    const records=await pool.query(`select a.attributes,a.organization_id,
      (select routing_enabled from partner_controls where actor_id=a.id) routing_enabled,
      (select count(*)::int from actor_capabilities where actor_id=a.id) capabilities,
      (select count(*)::int from capacity_snapshots where actor_id=a.id) capacity,
      (select count(*)::int from actor_qualification_evidence where actor_id=a.id) evidence
      from actors a where a.id=$1`,[input.requestId]);
    expect(records.rows[0]).toMatchObject({routing_enabled:false,capabilities:0,capacity:0,evidence:0,attributes:{onboardingSource:'shop_self_registration'}});
    const audit=(await pool.query(`select principal_role,principal_actor_id,principal_identity_id,rule_basis,metadata from audit_log where action='onboard_business' and object_id=$1`,[input.requestId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({principal_role:'partner',principal_actor_id:input.requestId,principal_identity_id:response.json().business.identityId,rule_basis:'shop_self_registration'});
    expect(JSON.stringify({audit,records:records.rows,response:response.body})).not.toContain(password);
    const listed=await app.inject({method:'GET',url:'/api/admin/business-onboarding',headers:admin});
    expect(listed.json().businesses.some((b:{actorId:string})=>b.actorId===input.requestId)).toBe(true);
  });
  it('serializes identical retries and rejects changed credentials or source reuse',async()=>{
    const input=fixture();
    const responses=await Promise.all([register(input),register(input)]);
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,201]);
    expect((await register({...input,password:'Different-owner-123!'})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/api/admin/business-onboarding',headers:admin,payload:{...input,role:'partner'}})).statusCode).toBe(409);
    expect((await pool.query(`select id from audit_log where action='onboard_business' and object_id=$1`,[input.requestId])).rowCount).toBe(1);
  });
  it('rolls back duplicate emails and prevents cross-shop access',async()=>{
    const first=fixture(), second=fixture();
    const a=await register(first); expect(a.statusCode).toBe(201);
    const duplicate={...fixture(),email:first.email};
    expect((await register(duplicate)).statusCode).toBe(409);
    expect((await pool.query('select id from organizations where display_name=$1',[duplicate.businessName])).rowCount).toBe(0);
    const b=await register(second); expect(b.statusCode).toBe(201);
    const headers={authorization:`Bearer ${(await login(first.email)).json().accessToken}`};
    expect((await app.inject({method:'GET',url:`/api/shop-os/local-intake?organizationId=${b.json().business.organizationId}`,headers})).statusCode).toBe(403);
  });
  it('rejects privileged fields and invalid input without provisioning records',async()=>{
    for(const extra of [{role:'admin'},{role:'partner'},{routing_enabled:true},{organizationId:randomUUID()},{password:'short'},{location:{...fixture().location,countryCode:'123'}},{location:{...fixture().location,organizationId:randomUUID()}}]){
      const input={...fixture(),...extra}; expect((await register(input)).statusCode).toBe(400);
      expect((await pool.query('select id from actors where id=$1',[input.requestId])).rowCount).toBe(0);
    }
  });
  it('limits public setup attempts by address',async()=>{
    for(let i=0;i<5;i++) expect((await register({},'198.51.100.77')).statusCode).toBe(400);
    expect((await register({},'198.51.100.77')).statusCode).toBe(429);
  });
});
