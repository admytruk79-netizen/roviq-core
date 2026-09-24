import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY=process.env.ADMIN_API_KEY!;
const adminHeaders={'x-roviq-role':'admin','x-admin-api-key':ADMIN_KEY};

describe('bearer token revocation and actor lifecycle',()=>{
  let app:FastifyInstance;

  beforeAll(async()=>{ app=await buildApp(); });
  afterAll(async()=>{ await app.close(); await pool.end(); });

  async function makeIdentity(label:string){
    const actor=await app.inject({
      method:'POST',url:'/api/admin/actors',headers:adminHeaders,
      payload:{actorType:'customer'}
    });
    const actorId=actor.json().actor.id as string;
    const email=`security-${label}-${Date.now()}-${Math.random()}@example.test`;
    const password='Secure-test-password-123!';
    const identity=await app.inject({
      method:'POST',url:'/api/admin/identities',headers:adminHeaders,
      payload:{email,password,role:'customer',actorId}
    });
    expect(identity.statusCode).toBe(201);
    return {actorId,identityId:identity.json().identity.id as string,email,password};
  }

  async function login(email:string,password:string){
    const response=await app.inject({
      method:'POST',url:'/api/auth/login',
      payload:{email,password}
    });
    expect(response.statusCode).toBe(200);
    return response.json().accessToken as string;
  }


  it('issues admin-created portal handoff tokens from real revocable identities',async()=>{
    const checks=[
      ['customer','/api/customers/me/cases'],
      ['diagnostic','/api/diagnostics/me/queue'],
      ['partner','/api/partners/me/offers'],
      ['parts','/api/parts/me/orders'],
      ['tow','/api/transport/me/dispatches'],
      ['fleet','/api/mobility/me/allocations']
    ] as const;

    for(const [role,path] of checks){
      const session=await app.inject({
        method:'POST',
        url:`/api/admin/testing/${role}-session`,
        headers:adminHeaders,
        payload:{}
      });
      expect(session.statusCode).toBe(200);
      const body=session.json();
      expect(body.principal.role).toBe(role);
      expect(body.principal.actorId).toBeTruthy();
      expect(body.accessToken).toBeTruthy();

      const protectedResponse=await app.inject({
        method:'GET',
        url:path,
        headers:{authorization:`Bearer ${body.accessToken}`}
      });
      expect(protectedResponse.statusCode).toBe(200);

      const identity=await pool.query(
        `select id,active,role,actor_id,email
           from principal_identities
          where actor_id=$1 and role=$2 and email=$3`,
        [body.principal.actorId,role,`admin_${role}_portal@testing.roviq.invalid`]
      );
      expect(identity.rowCount).toBe(1);
      expect(identity.rows[0]).toMatchObject({active:true,role,actor_id:body.principal.actorId});
    }
  });

  it('rejects an already-issued token after the identity is deactivated',async()=>{
    const user=await makeIdentity('identity-revoked');
    const token=await login(user.email,user.password);
    await pool.query('update principal_identities set active=false,updated_at=now() where id=$1',[user.identityId]);

    const response=await app.inject({
      method:'GET',url:'/api/me',
      headers:{authorization:`Bearer ${token}`}
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('inactive_or_revoked_identity');
  });

  it('rejects an already-issued non-admin token after its actor is disabled',async()=>{
    const user=await makeIdentity('actor-disabled');
    const token=await login(user.email,user.password);
    await pool.query("update actors set status='inactive' where id=$1",[user.actorId]);

    const response=await app.inject({
      method:'GET',url:'/api/me',
      headers:{authorization:`Bearer ${token}`}
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('inactive_or_revoked_identity');
  });
});
