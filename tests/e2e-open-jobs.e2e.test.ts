import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

// The open job board end to end: Ops opens a case to nearby technicians, better-ranked technicians
// see better jobs first, the first claim wins and becomes their job, and customers rate the work.

const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const admin = { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
const as = (role: string, actorId: string) => ({ 'x-roviq-role': role, 'x-roviq-actor-id': actorId });
const CAR = { lat: 43.6532, lng: -79.3832 };
const NEARBY = { lat: 43.7, lng: -79.4 };
const FAR = { lat: 45.4215, lng: -75.6972 };

describe('open job board', () => {
  let app: FastifyInstance;
  let customer: string;
  let gold: string;
  let silver: string;
  let other: string;

  const actor = async (actorType: string) => JSON.parse((await app.inject({ method: 'POST', url: '/api/admin/actors', headers: admin, payload: { actorType } })).body).actor.id as string;
  const newCase = async (vehicle: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST', url: '/api/demands', headers: as('customer', customer),
      payload: { domain: 'maintenance', demandType: 'check_engine_light', urgency: 'normal', location: CAR, vehicle, attributes: { description: 'Engine light on' }, ...extra }
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    return { caseId: body.case.id as string, demandId: body.demand.id as string };
  };
  const publish = (caseId: string) => app.inject({ method: 'POST', url: `/api/admin/cases/${caseId}/open-job`, headers: admin });
  const list = (actorId: string, at = NEARBY) => app.inject({ method: 'GET', url: `/api/diagnostics/open-jobs?lat=${at.lat}&lng=${at.lng}`, headers: as('diagnostic', actorId) });
  const claim = (actorId: string, jobId: string, at: unknown = NEARBY) => app.inject({ method: 'POST', url: `/api/diagnostics/open-jobs/${jobId}/claim`, headers: as('diagnostic', actorId), payload: at as object });

  beforeAll(async () => {
    app = await buildApp();
    customer = await actor('customer');
    gold = await actor('diagnostic');
    silver = await actor('diagnostic');
    other = await actor('diagnostic');
    // A gold record: 25 five-star jobs, all finished.
    const seedCase = await newCase({ year: 2015, make: 'Honda', model: 'Civic' });
    for (let i = 0; i < 25; i++) {
      const sc = await pool.query(`insert into service_cases(demand_id,domain_id,state) select demand_id,domain_id,'closed' from service_cases where id=$1 returning id`, [seedCase.caseId]);
      await pool.query(`insert into matches_offers(demand_id,case_id,actor_id,outcome,responded_at) values($1,$2,$3,'accepted',now()-interval '3 days')`, [seedCase.demandId, sc.rows[0].id, gold]);
      await pool.query(`insert into diagnostic_findings(demand_id,case_id,diagnostic_actor_id,summary,drivability,disposition) values($1,$2,$3,'Done','drivable','diagnose_only')`, [seedCase.demandId, sc.rows[0].id, gold]);
      await pool.query(`insert into provider_ratings(case_id,actor_id,stars) values($1,$2,5)`, [sc.rows[0].id, gold]);
    }
  });

  afterAll(async () => {
    await pool.query(`update open_jobs set state='withdrawn' where state='open'`);
    await app.close();
    await pool.end();
  });

  it('ranks technicians: a proven technician is gold, a new one silver', async () => {
    const g = JSON.parse((await app.inject({ method: 'GET', url: '/api/diagnostics/me/standing', headers: as('diagnostic', gold) })).body).standing;
    const s = JSON.parse((await app.inject({ method: 'GET', url: '/api/diagnostics/me/standing', headers: as('diagnostic', silver) })).body).standing;
    expect(g).toMatchObject({ tier: 'gold', ratingAverage: 5, completedJobs: 25 });
    expect(s).toMatchObject({ tier: 'silver', ratingCount: 0, completedJobs: 0 });
  });

  it('ranks the case like the car, shows premium jobs to gold first, and lets the first claim win', async () => {
    const { caseId } = await newCase({ year: new Date().getFullYear(), make: 'Porsche', model: 'Cayenne' });
    const published = await publish(caseId);
    expect(published.statusCode).toBe(201);
    const job = JSON.parse(published.body).openJob;
    expect(job).toMatchObject({ job_rank: 'premium', state: 'open' });
    expect((await publish(caseId)).statusCode).toBe(201);
    expect(JSON.parse((await publish(caseId)).body).openJob.id).toBe(job.id);
    const state = await pool.query('select state from service_cases where id=$1', [caseId]);
    expect(state.rows[0].state).toBe('diagnostic_pending');

    // Gold sees it straight away, with only what it needs to decide: no customer, no exact location.
    const goldView = JSON.parse((await list(gold)).body);
    const listed = goldView.jobs.find((j: { jobId: string }) => j.jobId === job.id);
    expect(listed).toMatchObject({ jobRank: 'premium', issueType: 'check_engine_light', vehicle: expect.stringContaining('Porsche Cayenne'), earlyAccess: true });
    expect(Object.keys(listed).sort()).toEqual(['distanceKm', 'earlyAccess', 'issueType', 'jobId', 'jobRank', 'postedAt', 'urgency', 'vehicle']);
    // Silver waits out gold's head start, and cannot claim early.
    expect(JSON.parse((await list(silver)).body).jobs.some((j: { jobId: string }) => j.jobId === job.id)).toBe(false);
    expect(JSON.parse((await claim(silver, job.id)).body).error).toBe('open_job_not_yet_available');
    // Too far away, or no location at all.
    expect((await claim(gold, job.id, FAR)).statusCode).toBe(403);
    expect((await claim(gold, job.id, {})).statusCode).toBe(400);
    expect(JSON.parse((await list(gold, FAR)).body).jobs.some((j: { jobId: string }) => j.jobId === job.id)).toBe(false);

    // After the head start, two technicians claim at once: exactly one wins.
    await pool.query(`update open_jobs set published_at=now()-interval '10 minutes' where id=$1`, [job.id]);
    const results = await Promise.all([claim(gold, job.id), claim(silver, job.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const winner = results[0].statusCode === 201 ? gold : silver;
    const after = await pool.query(
      `select sc.state, sc.current_owner_actor_id, o.state as listing, o.claimed_by_actor_id,
              (select count(*)::int from matches_offers where case_id=sc.id and outcome='accepted') as accepted
         from service_cases sc join open_jobs o on o.case_id=sc.id where sc.id=$1`, [caseId]);
    expect(after.rows[0]).toMatchObject({ state: 'diagnostic_in_progress', current_owner_actor_id: winner, listing: 'claimed', claimed_by_actor_id: winner, accepted: 1 });
    // The claimed job is in the winner's queue like any accepted job.
    const queue = JSON.parse((await app.inject({ method: 'GET', url: '/api/diagnostics/me/queue', headers: as('diagnostic', winner) })).body).queue;
    expect(queue.some((q: { case_id: string; outcome: string }) => q.case_id === caseId && q.outcome === 'accepted')).toBe(true);
    expect(JSON.parse((await app.inject({ method: 'GET', url: `/api/admin/cases/${caseId}/open-job`, headers: admin })).body).openJob).toMatchObject({ state: 'claimed', claimed_by_actor_id: winner });
  });

  it('shows basic jobs to everyone at once and sorts better jobs first', async () => {
    const basic = await newCase({ year: 2008, make: 'Toyota', model: 'Corolla' }, { demandType: 'oil_change' });
    const premium = await newCase({ year: new Date().getFullYear(), make: 'Tesla', model: 'Model Y', fuelType: 'electric' });
    const b = JSON.parse((await publish(basic.caseId)).body).openJob;
    const p = JSON.parse((await publish(premium.caseId)).body).openJob;
    expect(b.job_rank).toBe('basic');
    const silverJobs = JSON.parse((await list(silver)).body).jobs.map((j: { jobId: string }) => j.jobId);
    expect(silverJobs).toContain(b.id);
    expect(silverJobs).not.toContain(p.id);
    const goldJobs = JSON.parse((await list(gold)).body).jobs.map((j: { jobId: string }) => j.jobId);
    expect(goldJobs.indexOf(p.id)).toBeLessThan(goldJobs.indexOf(b.id));
  });

  it('takes the job off the board when Ops assigns it directly, or withdraws it', async () => {
    const one = await newCase({ year: 2019, make: 'Audi', model: 'Q5' });
    const job = JSON.parse((await publish(one.caseId)).body).openJob;
    const offer = await app.inject({ method: 'POST', url: '/api/admin/offers', headers: admin, payload: { demandId: one.demandId, actorId: other } });
    expect(offer.statusCode).toBe(201);
    expect((await pool.query('select state, withdrawn_reason from open_jobs where id=$1', [job.id])).rows[0]).toMatchObject({ state: 'withdrawn', withdrawn_reason: 'ops_assigned' });
    expect(JSON.parse((await claim(gold, job.id)).body).error).toBe('open_job_taken');
    expect(JSON.parse((await publish(one.caseId)).body).error).toBe('case_has_live_offer');

    const two = await newCase({ year: 2019, make: 'Audi', model: 'Q7' });
    await publish(two.caseId);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/cases/${two.caseId}/open-job`, headers: admin })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/cases/${two.caseId}/open-job`, headers: admin })).statusCode).toBe(404);
  });

  it('needs a location to publish, and is for technicians and Ops only', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/demands', headers: as('customer', customer), payload: { domain: 'maintenance', demandType: 'battery', urgency: 'normal', attributes: {} } });
    const caseId = JSON.parse(res.body).case.id;
    expect((await publish(caseId)).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/api/diagnostics/open-jobs?lat=1&lng=1', headers: as('customer', customer) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/admin/cases/${caseId}/open-job`, headers: as('diagnostic', gold) })).statusCode).toBe(403);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/diagnostics/open-jobs', headers: as('diagnostic', gold) })).body)).toMatchObject({ locationRequired: true, jobs: [] });
  });

  it('lets the customer rate the technician once the work is done, and only then', async () => {
    const { caseId, demandId } = await newCase({ year: 2020, make: 'Mazda', model: 'CX-5' });
    const job = JSON.parse((await publish(caseId)).body).openJob;
    await pool.query(`update open_jobs set published_at=now()-interval '10 minutes' where id=$1`, [job.id]);
    expect((await claim(silver, job.id)).statusCode).toBe(201);
    const rate = (stars: number, actorId = silver, who = customer) => app.inject({ method: 'POST', url: `/api/maintenance/cases/${caseId}/ratings`, headers: as('customer', who), payload: { actorId, stars, comment: 'Quick and clear' } });

    expect(JSON.parse((await rate(5)).body).error).toBe('rating_too_early');
    await pool.query(`insert into diagnostic_findings(demand_id,case_id,diagnostic_actor_id,summary,drivability,disposition) values($1,$2,$3,'Loose gas cap','drivable','diagnose_only')`, [demandId, caseId, silver]);
    const providers = JSON.parse((await app.inject({ method: 'GET', url: `/api/maintenance/cases/${caseId}/ratings`, headers: as('customer', customer) })).body).providers;
    expect(providers).toEqual([expect.objectContaining({ actorId: silver, canRate: true, stars: null })]);
    expect((await rate(4)).statusCode).toBe(201);
    expect((await rate(5)).statusCode).toBe(201);
    expect((await pool.query('select stars from provider_ratings where case_id=$1', [caseId])).rows).toEqual([{ stars: 5 }]);
    // Only the case's customer, only providers who worked it, only 1-5 stars.
    expect((await rate(5, silver, await actor('customer'))).statusCode).toBe(404);
    expect((await rate(5, gold)).statusCode).toBe(404);
    expect((await rate(6)).statusCode).toBe(400);
    const standing = JSON.parse((await app.inject({ method: 'GET', url: '/api/diagnostics/me/standing', headers: as('diagnostic', silver) })).body).standing;
    expect(standing).toMatchObject({ ratingCount: 1, ratingAverage: 5, completedJobs: 1 });
  });
});
