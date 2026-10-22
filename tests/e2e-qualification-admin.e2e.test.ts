import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const devAdmin = { 'x-roviq-role':'admin', 'x-admin-api-key':process.env.ADMIN_API_KEY! };
describe('identified Ops qualification reviews and routing evidence', () => {
  let app: FastifyInstance; let admin: Record<string,string>; let identityId: string;
  let actor: string; let other: string; let caseId: string;
  const payload = (change: Record<string,unknown> = {}) => ({ expectedVersion:0,requirementKey:'ev-hv',kind:'training',
    scope:'vehicle-x/hv',status:'verified',source:'Issuer portal / certificate 123',validUntil:'2050-01-01T00:00:00Z',
    reason:'Issuer and training scope checked by Ops',...change });
  beforeAll(async () => {
    app = await buildApp();
    const email = `qualification-admin-${randomUUID()}@example.test`; const password = 'Qualification-admin-123!';
    const identity = await app.inject({ method:'POST',url:'/api/admin/identities',headers:devAdmin,payload:{ email,password,role:'admin' } });
    expect(identity.statusCode).toBe(201); identityId = identity.json().identity.id;
    const login = await app.inject({ method:'POST',url:'/api/auth/login',payload:{ email,password } });
    expect(login.statusCode).toBe(200); admin = { authorization:`Bearer ${login.json().accessToken}` };
    const createActor = async (actorType: string) => (await app.inject({ method:'POST',url:'/api/admin/actors',headers:devAdmin,payload:{ actorType } })).json().actor.id as string;
    actor = await createActor('partner'); other = await createActor('partner'); const customer = await createActor('customer');
    const demand = await app.inject({ method:'POST',url:'/api/demands',headers:{'x-roviq-role':'customer','x-roviq-actor-id':customer},
      payload:{domain:'maintenance',demandType:'wont_start',urgency:'normal',location:{lat:45.5,lng:-122.6}} });
    expect(demand.statusCode).toBe(201); caseId = demand.json().case.id;
    await pool.query(`insert into case_qualification_requirements(service_case_id,requirement_key,kind,scope) values($1,'ev-hv','training','vehicle-x/hv')`, [caseId]);
  });
  afterAll(async () => { await app.close(); await pool.end(); });
  const save = (id: string, input = payload(), headers = admin, actorId = actor) => app.inject({method:'PUT',url:`/api/admin/qualifications/${actorId}/${id}`,headers,payload:input});
  const evaluate = async () => (await app.inject({method:'GET',url:`/api/admin/qualifications/${actor}/cases/${caseId}`,headers:admin})).json().evaluation;
  const registry = () => app.inject({method:'GET',url:`/api/admin/qualifications/${actor}`,headers:admin});

  it('requires admin access and an identified reviewer; refuses spoofed reviewer fields', async () => {
    const partner = {'x-roviq-role':'partner','x-roviq-actor-id':actor};
    expect((await app.inject({method:'GET',url:`/api/admin/qualifications/${actor}`,headers:partner})).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url:'/api/admin/qualifications/actors',headers:partner})).statusCode).toBe(403);
    expect((await save(randomUUID(),payload(),partner)).statusCode).toBe(403);
    expect((await save(randomUUID(),payload(),devAdmin)).statusCode).toBe(403);
    expect((await save(randomUUID(),payload({verified_by:'someone-else'}))).statusCode).toBe(400);
    expect((await registry()).json().evidence).toEqual([]);
  });

  it('finds the exact operator independently of registry pagination', async () => {
    const found = await app.inject({method:'GET',url:`/api/admin/qualifications/actors?search=${actor}`,headers:admin});
    expect(found.statusCode).toBe(200);
    expect(found.json().actors.map((a: {id:string}) => a.id)).toEqual([actor]);
    expect(found.json().truncated).toBe(false);
  });

  it('registers sourced evidence, evaluates matching requirements, and preserves review provenance', async () => {
    expect((await evaluate()).decision).toBe('blocked');
    const id = randomUUID(); const saved = await save(id);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().evidence).toMatchObject({id,review_version:1,reviewed_by_identity_id:identityId,verified_by:identityId});
    expect((await evaluate()).decision).toBe('eligible');
    expect((await save(id,payload({expectedVersion:1,status:'revoked',reason:'Issuer has revoked the certificate'}))).statusCode).toBe(200);
    expect((await evaluate()).decision).toBe('blocked');
    const data = (await registry()).json();
    expect(data.history.filter((h: {metadata:{after:{id:string}}}) => h.metadata.after.id===id)).toHaveLength(2);
    const revoked = data.history.find((h: {metadata:{after:{evidence_status:string}}}) => h.metadata.after.evidence_status==='revoked');
    expect(revoked.metadata.before.evidence_status).toBe('verified');
    expect(revoked.principal_identity_id).toBe(identityId);
  });

  it('rejects stale re-verification and concurrent reviews instead of overwriting revocation', async () => {
    const id = randomUUID(); expect((await save(id)).statusCode).toBe(200);
    const attempts = await Promise.all([
      save(id,payload({expectedVersion:1,status:'revoked'})),save(id,payload({expectedVersion:1,status:'unverified'}))
    ]);
    expect(attempts.map(r => r.statusCode).sort()).toEqual([200,409]);
    expect((await save(id,payload({expectedVersion:1}))).statusCode).toBe(409);
    const audits = await pool.query(`select count(*)::int as n from audit_log where action='review_actor_qualification' and object_id=$1`, [id]);
    expect(audits.rows[0].n).toBe(2);
  });

  it('prevents evidence ID reuse across operators, including simultaneous creation', async () => {
    const id = randomUUID();
    const attempts = await Promise.all([save(id),save(id,payload(),admin,other)]);
    expect(attempts.map(r => r.statusCode).sort()).toEqual([200,409]);
    const record = (await pool.query('select actor_id from actor_qualification_evidence where id=$1',[id])).rows[0];
    expect((await save(id,payload({expectedVersion:1,status:'revoked'}),admin,record.actor_id)).statusCode).toBe(200);
  });

  it('does not accept missing provenance, elapsed expiry or a changed requirement identity', async () => {
    expect((await save(randomUUID(),payload({source:'   '}))).statusCode).toBe(400);
    expect((await save(randomUUID(),payload({validUntil:'2020-01-01T00:00:00Z'}))).statusCode).toBe(400);
    const id = randomUUID(); expect((await save(id,payload({status:'unverified'}))).statusCode).toBe(200);
    expect((await save(id,payload({expectedVersion:1,scope:'other-vehicle'}))).statusCode).toBe(409);
    expect((await save(id,payload({expectedVersion:1,kind:'legal_license'}))).statusCode).toBe(409);
  });

  it('treats expiry by time and revokes one record without hiding another valid certificate', async () => {
    // Isolate this scenario from prior records; keep their audit history.
    await pool.query(`update actor_qualification_evidence set evidence_status='revoked' where actor_id=$1`,[actor]);
    const first = randomUUID(); const second = randomUUID();
    expect((await save(first)).statusCode).toBe(200); expect((await save(second)).statusCode).toBe(200);
    expect((await save(first,payload({expectedVersion:1,status:'revoked'}))).statusCode).toBe(200);
    expect((await evaluate()).decision).toBe('eligible');
    await pool.query(`update actor_qualification_evidence set valid_until='2020-01-01' where id=$1`,[second]);
    expect((await evaluate()).decision).toBe('blocked');
    expect((await registry()).json().evidence.find((e: {id:string})=>e.id===second).effective_status).toBe('expired');
    expect((await save(second,payload({expectedVersion:1,validUntil:null}))).statusCode).toBe(200);
    expect((await evaluate()).decision).toBe('eligible');
  });

  it('rolls back evidence when the audit insert fails', async () => {
    const id = randomUUID();
    await pool.query(`create function reject_qualification_test_audit() returns trigger language plpgsql as $$
      begin if new.object_id='${id}' then raise exception 'qualification_test_audit_failure'; end if; return new; end $$`);
    await pool.query(`create trigger reject_qualification_test_audit before insert on audit_log for each row execute function reject_qualification_test_audit()`);
    const errors = vi.spyOn(console,'error').mockImplementation(() => {});
    try {
      expect((await save(id)).statusCode).toBe(500);
      expect(errors.mock.calls.some(call => JSON.stringify(call).includes('qualification_test_audit_failure'))).toBe(true);
      expect((await pool.query('select id from actor_qualification_evidence where id=$1',[id])).rowCount).toBe(0);
    } finally {
      errors.mockRestore();
      await pool.query('drop trigger reject_qualification_test_audit on audit_log');
      await pool.query('drop function reject_qualification_test_audit()');
    }
  });

  it('audits identified case requirement changes and refuses changes on a closed case', async () => {
    const url = `/api/admin/qualifications/cases/${caseId}/requirements/safety-hv`;
    const input = {kind:'training',scope:'vehicle-x/hv',mandatory:true,reason:'Confirmed task-specific safety requirements'};
    const write = (headers: Record<string,string>, change = {}) => app.inject({method:'PUT',url,headers,payload:{...input,...change}});
    expect((await write(devAdmin)).statusCode).toBe(403);
    expect((await write({'x-roviq-role':'partner','x-roviq-actor-id':actor})).statusCode).toBe(403);
    // Demand intake automatically runs triage/routing; stage the intake guard explicitly.
    await pool.query(`update service_cases set state='intake',selected_actor_id=null where id=$1`,[caseId]);
    expect((await write(admin)).statusCode).toBe(409);
    await pool.query(`update service_cases set state='triage' where id=$1`,[caseId]);
    const created = await write(admin); expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({requirement:{requirement_key:'safety-hv',mandatory:true},rerouteRequired:true});
    expect((await write(admin,{mandatory:false,reason:'Task scope reassessed by administrator'})).statusCode).toBe(200);
    const requirements = await app.inject({method:'GET',url:`/api/admin/qualifications/cases/${caseId}/requirements`,headers:admin});
    expect(requirements.statusCode).toBe(200);
    expect(requirements.json().requirements.find((r: {requirement_key:string}) => r.requirement_key==='safety-hv').mandatory).toBe(false);
    const audits = await pool.query(`select metadata,principal_identity_id from audit_log where action='upsert_case_qualification' and object_id=$1 order by occurred_at`,[created.json().requirement.id]);
    expect(audits.rowCount).toBe(2);
    expect(audits.rows[1]).toMatchObject({principal_identity_id:identityId,metadata:{before:{mandatory:true},after:{mandatory:false}}});
    await pool.query(`update service_cases set state='cancelled' where id=$1`,[caseId]);
    expect((await write(admin)).statusCode).toBe(409);
  });
});
