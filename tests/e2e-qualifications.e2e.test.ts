import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// Case qualification requirements (MACRE) apply on every way a technician can get a case:
// the open job board (listing and claiming), a direct Ops offer, and accepting an offer.
// Ops manages requirements and verified credentials; a case without requirements is unaffected.

const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': process.env.ADMIN_API_KEY! };
const as = (role: string, actorId: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actorId });
const CAR = { lat: 43.6532, lng: -79.3832 };
const NEAR = { lat: 43.66, lng: -79.39 };

describe('qualification gates', () => {
  let app: FastifyInstance;
  let customer: string;
  let qualified: string;
  let unqualified: string;

  const actor = async (actorType: string) => JSON.parse((await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType } })).body).actor.id as string;
  const newCase = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/demands', headers: as('customer', customer), payload: { domain: 'maintenance', demandType: 'check_engine_light', urgency: 'normal', location: CAR, vehicle: { year: 2015, make: 'Nissan', model: 'Leaf', fuelType: 'electric' }, attributes: { description: 'Warning light' } } });
    expect(res.statusCode).toBe(201);
    const b = JSON.parse(res.body);
    return { caseId: b.case.id as string, demandId: b.demand.id as string };
  };
  const requireEv = (caseId: string) => app.inject({ method: 'PUT', url: `/api/admin/cases/${caseId}/qualifications`, headers: admin, payload: { requirementKey: 'ev_high_voltage', kind: 'training', mandatory: true } });
  const publish = async (caseId: string) => {
    const job = JSON.parse((await app.inject({ method: 'POST', url: `/api/admin/cases/${caseId}/open-job`, headers: admin })).body).openJob;
    await pool.query(`update open_jobs set published_at=now()-interval '10 minutes' where id=$1`, [job.id]);
    return job.id as string;
  };
  const board = async (actorId: string) => JSON.parse((await app.inject({ method: 'GET', url: `/api/diagnostics/open-jobs?lat=${NEAR.lat}&lng=${NEAR.lng}`, headers: as('diagnostic', actorId) })).body).jobs.map((j: { jobId: string }) => j.jobId);
  const claim = (actorId: string, jobId: string) => app.inject({ method: 'POST', url: `/api/diagnostics/open-jobs/${jobId}/claim`, headers: as('diagnostic', actorId), payload: NEAR });

  beforeAll(async () => {
    app = await buildApp();
    customer = await actor('customer');
    qualified = await actor('diagnostic');
    unqualified = await actor('diagnostic');
    const recorded = await app.inject({ method: 'POST', url: `/api/admin/actors/${qualified}/qualification-evidence`, headers: admin, payload: { requirementKey: 'ev_high_voltage', kind: 'training', verifiedSource: 'EV safety certificate 4471', validUntil: new Date(Date.now() + 365 * 86400_000).toISOString() } });
    expect(recorded.statusCode).toBe(201);
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
    expect(JSON.parse((await app.inject({ method: 'GET', url: `/api/admin/cases/${caseId}/qualifications`, headers: admin })).body).requirements).toEqual([]);
  });

  it('hides a gated job from unqualified technicians and refuses their claim', async () => {
    const { caseId } = await newCase();
    expect((await requireEv(caseId)).statusCode).toBe(201);
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
    const candidates = JSON.parse((await app.inject({ method: 'GET', url: `/api/admin/cases/${caseId}/qualifications/candidates?actorType=diagnostic`, headers: admin })).body).candidates;
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
    const ev = JSON.parse((await app.inject({ method: 'POST', url: `/api/admin/actors/${tech}/qualification-evidence`, headers: admin, payload: { requirementKey: 'ev_high_voltage', kind: 'training', verifiedSource: 'EV safety certificate 9001' } })).body).evidence;
    const { caseId, demandId } = await newCase();
    await requireEv(caseId);
    await app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/transition`, headers: admin, payload: { toState: 'diagnostic_pending' } });
    const offer = JSON.parse((await app.inject({ method: 'POST', url: '/api/admin/offers', headers: admin, payload: { demandId, actorId: tech } })).body).offer;
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/actors/${tech}/qualification-evidence/${ev.id}`, headers: admin, payload: { status: 'revoked' } })).statusCode).toBe(200);
    const accept = await app.inject({ method: 'POST', url: `/api/offers/${offer.id}/respond`, headers: as('diagnostic', tech), payload: { outcome: 'accepted' } });
    expect(accept.statusCode).toBe(403);
    expect((await pool.query('select outcome from matches_offers where id=$1', [offer.id])).rows[0].outcome).toBe('offered');
    // Declining still works.
    expect((await app.inject({ method: 'POST', url: `/api/offers/${offer.id}/respond`, headers: as('diagnostic', tech), payload: { outcome: 'declined' } })).statusCode).toBe(200);
  });

  it('validates credentials and keeps them admin-only', async () => {
    const bad = await app.inject({ method: 'POST', url: `/api/admin/actors/${unqualified}/qualification-evidence`, headers: admin, payload: { requirementKey: 'ev_high_voltage', kind: 'training' } });
    expect(bad.statusCode).toBe(400);
    const past = await app.inject({ method: 'POST', url: `/api/admin/actors/${unqualified}/qualification-evidence`, headers: admin, payload: { requirementKey: 'ev_high_voltage', kind: 'training', verifiedSource: 'old cert', validUntil: '2020-01-01T00:00:00.000Z' } });
    expect(JSON.parse(past.body).error).toBe('evidence_already_expired');
    expect((await app.inject({ method: 'PUT', url: `/api/admin/cases/00000000-0000-4000-8000-000000000000/qualifications`, headers: admin, payload: { requirementKey: 'Bad Key!', kind: 'training' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/admin/actors/${qualified}/qualification-evidence`, headers: as('diagnostic', qualified) })).statusCode).toBe(403);
    const { caseId } = await newCase();
    await requireEv(caseId);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/cases/${caseId}/qualifications/ev_high_voltage`, headers: admin })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/cases/${caseId}/qualifications/ev_high_voltage`, headers: admin })).statusCode).toBe(404);
  });
});
