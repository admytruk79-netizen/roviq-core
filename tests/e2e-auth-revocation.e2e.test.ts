import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { verifyAccessToken } from '../src/services/auth.js';

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


  it('backs admin-created portal handoff tokens with an active revalidatable identity',async()=>{
    const response=await app.inject({
      method:'POST',
      url:'/api/admin/testing/customer-session',
      headers:adminHeaders
    });
    expect(response.statusCode).toBe(200);
    const body=response.json();
    const verified=await verifyAccessToken(body.accessToken);
    expect(verified.role).toBe('customer');
    expect(verified.actorId).toBe(body.principal.actorId);
    expect(verified.identityId).toMatch(/^[0-9a-f-]{36}$/i);

    const identity=await pool.query(
      `select pi.active,pi.role,pi.actor_id,a.status as actor_status
         from principal_identities pi
         join actors a on a.id=pi.actor_id
        where pi.id=$1`,
      [verified.identityId]
    );
    expect(identity.rows[0]).toMatchObject({
      active:true,
      role:'customer',
      actor_id:body.principal.actorId,
      actor_status:'active'
    });

    const me=await app.inject({
      method:'GET',
      url:'/api/me',
      headers:{authorization:`Bearer ${body.accessToken}`}
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal).toMatchObject({role:'customer',actorId:body.principal.actorId});
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
