import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// Case qualification requirements (MACRE) apply on every way a technician can get a case:
// the open job board (listing and claiming), a direct Ops offer, and accepting an offer.
// Requirements and credentials are written through the audited qualification admin API by a
// named admin; a case without requirements is unaffected.

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };
const as = (role: string, actorId: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actorId });
const CAR = { lat: 43.6532, lng: -79.3832 };
const NEAR = { lat: 43.66, lng: -79.39 };

describe('qualification gates', () => {
  let app: FastifyInstance;
  let customer: string;
  let qualified: string;
  let unqualified: string;
  let named: Record<string, string>;

  const actor = async (actorType: string) => JSON.parse((await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType } })).body).actor.id as string;
  const newCase = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/demands', headers: as('customer', customer), payload: { domain: 'maintenance', demandType: 'check_engine_light', urgency: 'normal', location: CAR, vehicle: { year: 2015, make: 'Nissan', model: 'Leaf', fuelType: 'electric' }, attributes: { description: 'Warning light' } } });
    expect(res.statusCode).toBe(201);
    const b = JSON.parse(res.body);
    return { caseId: b.case.id as string, demandId: b.demand.id as string };
  };
  const requireEv = (caseId: string) => app.inject({ method: 'PUT', url: `/api/admin/qualifications/cases/${caseId}/requirements/ev_high_voltage`, headers: named, payload: { kind: 'training', scope: null, mandatory: true, reason: 'EV high-voltage work' } });
  const review = (actorId: string, evidenceId: string, change: Record<string, unknown> = {}) => app.inject({
    method: 'PUT', url: `/api/admin/qualifications/${actorId}/${evidenceId}`, headers: named,
    payload: { expectedVersion: 0, requirementKey: 'ev_high_voltage', kind: 'training', scope: null, status: 'verified', source: 'EV safety certificate 4471', validUntil: null, reason: 'Certificate checked by Ops', ...change }
  });
  const publish = async (caseId: string) => {
    const job = JSON.parse((await app.inject({ method: 'POST', url: `/api/admin/cases/${caseId}/open-job`, headers: admin })).body).openJob;
    await pool.query(`update open_jobs set published_at=now()-interval '10 minutes' where id=$1`, [job.id]);
    return job.id as string;
  };
  const board = async (actorId: string) => JSON.parse((await app.inject({ method: 'GET', url: `/api/diagnostics/open-jobs?lat=${NEAR.lat}&lng=${NEAR.lng}`, headers: as('diagnostic', actorId) })).body).jobs.map((j: { jobId: string }) => j.jobId);
  const claim = (actorId: string, jobId: string) => app.inject({ method: 'POST', url: `/api/diagnostics/open-jobs/${jobId}/claim`, headers: as('diagnostic', actorId), payload: NEAR });

  beforeAll(async () => {
    app = await buildApp();
    const email = `qualification-gates-${randomUUID()}@example.test`;
    const password = 'Qualification-gates-123!';
    expect((await app.inject({ method: 'POST', url: '/api/admin/identities', headers: admin, payload: { email, password, role: 'admin' } })).statusCode).toBe(201);
    named = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).json().accessToken}` };
    customer = await actor('customer');
    qualified = await actor('diagnostic');
    unqualified = await actor('diagnostic');
    expect((await review(qualified, randomUUID())).statusCode).toBe(200);
  });

  afterAll(async () => {
    await pool.query(`update open_jobs set state='withdrawn' where state='open'`);
    await app.close();
    await pool.end();
  });

  it('leaves a case without requirements open to everyone', async () => {
    const { caseId } = await newCase();
    const jobId = await publish(caseId);
    expect(await board(unqualified)).toContain(jobId);
    expect(JSON.parse((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/${caseId}/requirements`, headers: admin })).body).requirements).toEqual([]);
  });

  it('hides a gated job from unqualified technicians and refuses their claim', async () => {
    const { caseId } = await newCase();
    expect((await requireEv(caseId)).statusCode).toBe(200);
    const jobId = await publish(caseId);
    expect(await board(unqualified)).not.toContain(jobId);
    expect(await board(qualified)).toContain(jobId);
    const refused = await claim(unqualified, jobId);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).error).toBe('qualification_required');
    expect((await pool.query('select state from open_jobs where id=$1', [jobId])).rows[0].state).toBe('open');
    expect((await claim(qualified, jobId)).statusCode).toBe(201);
  });

  it('shows Ops who qualifies, and refuses a direct offer to someone who does not', async () => {
    const { caseId, demandId } = await newCase();
    await requireEv(caseId);
    const candidates = JSON.parse((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/${caseId}/candidates?actorType=diagnostic`, headers: admin })).body).candidates;
    expect(candidates.find((c: { actorId: string }) => c.actorId === qualified)).toMatchObject({ decision: 'eligible' });
    expect(candidates.find((c: { actorId: string }) => c.actorId === unqualified)).toMatchObject({ decision: 'blocked', blockingReasons: ['training:ev_high_voltage:missing_evidence'] });
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: admin, payload: { toState: 'diagnostic_pending' } });
    const refused = await app.inject({ method: 'POST', url: '/api/admin/offers', headers: admin, payload: { demandId, actorId: unqualified } });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'qualification_blocked', reasons: ['training:ev_high_voltage:missing_evidence'] });
    expect((await app.inject({ method: 'POST', url: '/api/admin/offers', headers: admin, payload: { demandId, actorId: qualified } })).statusCode).toBe(201);
  });

  it('withdraws an open offer when its required credential is revoked', async () => {
    const tech = await actor('diagnostic');
    const evidenceId = randomUUID();
    expect((await review(tech, evidenceId)).statusCode).toBe(200);
    const { caseId, demandId } = await newCase();
    await requireEv(caseId);
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: admin, payload: { toState: 'diagnostic_pending' } });
    const offer = JSON.parse((await app.inject({ method: 'POST', url: '/api/admin/offers', headers: admin, payload: { demandId, actorId: tech } })).body).offer;
    const revoked = await review(tech, evidenceId, { expectedVersion: 1, status: 'revoked', reason: 'Issuer revoked the certificate' });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().impactedCases).toContainEqual({caseId, outcome:'provider_qualification_reroute_required'});
    const accept = await app.inject({ method: 'POST', url: `/api/offers/${offer.id}/respond`, headers: as('diagnostic', tech), payload: { outcome: 'accepted' } });
    expect(accept.statusCode).toBe(404);
    expect((await pool.query('select outcome from matches_offers where id=$1', [offer.id])).rows[0].outcome).toBe('declined');
    expect((await pool.query('select current_owner_actor_id from service_cases where id=$1',[caseId])).rows[0].current_owner_actor_id).not.toBe(tech);
    expect((await pool.query("select id from case_exceptions where case_id=$1 and exception_code='PROVIDER_QUALIFICATION_REVIEW'",[caseId])).rowCount).toBe(1);
  });

  it('keeps the who-qualifies list admin-only', async () => {
    const { caseId } = await newCase();
    expect((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/${caseId}/candidates`, headers: as('diagnostic', qualified) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/00000000-0000-4000-8000-000000000000/candidates`, headers: admin })).statusCode).toBe(404);
  });

  it.each(['offer','claim'])('serializes %s acceptance behind an in-flight credential revocation', async (path) => {
    const tech = await actor('diagnostic');
    const evidenceId = randomUUID();
    expect((await review(tech,evidenceId)).statusCode).toBe(200);
    const {caseId,demandId} = await newCase();
    expect((await requireEv(caseId)).statusCode).toBe(200);
    let accept: () => ReturnType<typeof app.inject>;
    let offerId: string | undefined;
    let jobId: string | undefined;
    if (path==='offer') {
      await app.inject({method:'POST',url:`/api/maintenance/cases/${caseId}/transition`,headers:admin,payload:{toState:'diagnostic_pending'}});
      const offered = await app.inject({method:'POST',url:'/api/admin/offers',headers:admin,payload:{demandId,actorId:tech}});
      expect(offered.statusCode).toBe(201); offerId = offered.json().offer.id;
      accept = () => app.inject({method:'POST',url:`/api/offers/${offerId}/respond`,headers:as('diagnostic',tech),payload:{outcome:'accepted'}});
    } else {
      jobId = await publish(caseId);
      accept = () => claim(tech,jobId!);
    }
    const revoker = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await revoker.query('begin');
      await revoker.query('select id from actors where id=$1 for update',[tech]);
      await revoker.query(`update actor_qualification_evidence set evidence_status='revoked' where id=$1`,[evidenceId]);
      let settled = false;
      const response = Promise.resolve(accept()).then(r => { settled=true; return r; }); pending = response;
      const deadline = Date.now()+4000;
      let waiting = false;
      while (Date.now()<deadline && !settled) {
        const locks = await pool.query(`select exists(select 1 from pg_stat_activity
          where wait_event_type='Lock' and query like '%qualification_write_guard%') as waiting`);
        if (locks.rows[0].waiting) { waiting=true; break; }
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(waiting,'acceptance must wait on the credential reviewer, not use old evidence').toBe(true);
      expect(settled).toBe(false);
      await revoker.query('commit');
      expect((await response).statusCode).toBe(403);
      if (offerId) expect((await pool.query('select outcome from matches_offers where id=$1',[offerId])).rows[0].outcome).toBe('offered');
      if (jobId) expect((await pool.query('select state from open_jobs where id=$1',[jobId])).rows[0].state).toBe('open');
      expect((await pool.query('select current_owner_actor_id from service_cases where id=$1',[caseId])).rows[0].current_owner_actor_id).not.toBe(tech);
    } finally {
      await revoker.query('rollback'); revoker.release();
      await pending;
    }
  },15000);
});
