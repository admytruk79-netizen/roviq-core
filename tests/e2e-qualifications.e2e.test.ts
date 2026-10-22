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

  it('checks again at acceptance, so a credential revoked after the offer blocks it', async () => {
    const tech = await actor('diagnostic');
    const evidenceId = randomUUID();
    expect((await review(tech, evidenceId)).statusCode).toBe(200);
    const { caseId, demandId } = await newCase();
    await requireEv(caseId);
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: admin, payload: { toState: 'diagnostic_pending' } });
    const offer = JSON.parse((await app.inject({ method: 'POST', url: '/api/admin/offers', headers: admin, payload: { demandId, actorId: tech } })).body).offer;
    expect((await review(tech, evidenceId, { expectedVersion: 1, status: 'revoked', reason: 'Issuer revoked the certificate' })).statusCode).toBe(200);
    const accept = await app.inject({ method: 'POST', url: `/api/offers/${offer.id}/respond`, headers: as('diagnostic', tech), payload: { outcome: 'accepted' } });
    expect(accept.statusCode).toBe(403);
    expect((await pool.query('select outcome from matches_offers where id=$1', [offer.id])).rows[0].outcome).toBe('offered');
    // Declining still works.
    expect((await app.inject({ method: 'POST', url: `/api/offers/${offer.id}/respond`, headers: as('diagnostic', tech), payload: { outcome: 'declined' } })).statusCode).toBe(200);
  });

  it('keeps the who-qualifies list admin-only', async () => {
    const { caseId } = await newCase();
    expect((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/${caseId}/candidates`, headers: as('diagnostic', qualified) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/admin/qualifications/cases/00000000-0000-4000-8000-000000000000/candidates`, headers: admin })).statusCode).toBe(404);
  });
});
