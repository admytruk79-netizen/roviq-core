import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';
import { transitionCase } from './orchestration.js';
import { assertQualified, casesWithRequirements, qualificationBlockingReasons } from './qualification-gate.js';

// Open job board, Uber-style. Ops (or auto-publish) opens a case to nearby technicians; they claim
// it, first claim wins. Every job is ranked premium / standard / basic from the vehicle, urgency and
// work, and every technician is ranked gold / silver / bronze from customer ratings, completed jobs
// and experience. Better-ranked technicians see better jobs first: a premium job is shown to gold
// technicians straight away and to the others after a head start. Before claiming, a technician
// sees only the issue, vehicle, urgency, rank and rough distance, never who or exactly where.

const SYSTEM: Principal = { role: 'admin' };
export const RADIUS_KM = 50;

export type JobRank = 'premium' | 'standard' | 'basic';
export type Tier = 'gold' | 'silver' | 'bronze';
type Queryable = Pick<PoolClient, 'query'>;

const PREMIUM_MAKES = new Set([
  'acura', 'alfa romeo', 'aston martin', 'audi', 'bentley', 'bmw', 'cadillac', 'ferrari', 'genesis', 'infiniti', 'jaguar',
  'lamborghini', 'land rover', 'range rover', 'lexus', 'lincoln', 'lucid', 'maserati', 'mclaren', 'mercedes', 'mercedes-benz',
  'polestar', 'porsche', 'rivian', 'rolls-royce', 'tesla', 'volvo'
]);
const HEAVY_DUTY = /\b(f-?(250|350|450|550)|super ?duty|2500|3500|hd)\b/i;
const COMPLEX_WORK = new Set(['check_engine_light', 'check_engine', 'transmission', 'ac_heating', 'electrical', 'warning_light']);

export type RankInput = {
  year?: number | null; make?: string | null; model?: string | null; fuelType?: string | null; drivetrain?: string | null;
  demandType?: string | null; urgency?: string | null; now?: Date;
};

/** How good a job is, from the vehicle, the urgency and the work. 0-100, with the reasons. */
export function rankJob(input: RankInput): { rank: JobRank; score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => { score += points; reasons.push(reason); };
  const make = String(input.make ?? '').trim().toLowerCase();
  if (make && PREMIUM_MAKES.has(make)) add(40, 'Premium make');
  if (HEAVY_DUTY.test(String(input.model ?? ''))) add(20, 'Heavy-duty truck');
  const year = Number(input.year);
  if (Number.isInteger(year) && year > 1900) {
    const age = (input.now ?? new Date()).getFullYear() - year;
    if (age <= 3) add(20, 'Recent model');
    else if (age <= 7) add(10, 'Late model');
  }
  if (['electric', 'hybrid', 'plug_in_hybrid'].includes(String(input.fuelType ?? ''))) add(15, 'EV or hybrid systems');
  if (['awd', '4wd'].includes(String(input.drivetrain ?? ''))) add(5, 'AWD / 4WD');
  if (input.urgency === 'emergency') add(20, 'Emergency');
  else if (input.urgency === 'urgent') add(10, 'Urgent');
  if (COMPLEX_WORK.has(String(input.demandType ?? ''))) add(10, 'Complex diagnosis');
  score = Math.min(100, score);
  return { rank: score >= 50 ? 'premium' : score >= 25 ? 'standard' : 'basic', score, reasons };
}

/** Seconds after publishing before a technician of this tier can see and claim the job. */
export function releaseDelaySeconds(rank: JobRank, tier: Tier, urgency?: string | null) {
  const table: Record<JobRank, Record<Tier, number>> = {
    premium: { gold: 0, silver: 120, bronze: 300 },
    standard: { gold: 0, silver: 45, bronze: 120 },
    basic: { gold: 0, silver: 0, bronze: 0 }
  };
  const delay = table[rank][tier];
  // A customer waiting in an emergency should not wait on the head start: halve it.
  return urgency === 'emergency' ? Math.round(delay / 2) : delay;
}

export type Standing = {
  tier: Tier; score: number; ratingAverage: number | null; ratingCount: number; completedJobs: number; settledJobs: number; completionRate: number | null;
};

/**
 * A technician's rank from what Core records: customer star ratings, the share of claimed or
 * accepted jobs they finished (a job counts once it has a finding, or 48 hours after acceptance),
 * and how many they have finished. Small samples are pulled toward a neutral prior, so a new
 * technician starts mid-table (silver) rather than at the top or bottom.
 */
export function standingFrom(ratingSum: number, ratingCount: number, completed: number, settled: number): Standing {
  const ratingBayes = (ratingSum + 4.5 * 5) / (ratingCount + 5);
  const completionBayes = (completed + 0.9 * 5) / (settled + 5);
  const score = Math.round(45 * ((ratingBayes - 1) / 4) + 35 * completionBayes + 20 * Math.min(completed / 20, 1));
  return {
    tier: score >= 80 ? 'gold' : score >= 60 ? 'silver' : 'bronze',
    score,
    ratingAverage: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
    ratingCount,
    completedJobs: completed,
    settledJobs: settled,
    completionRate: settled ? Math.round((completed / settled) * 100) / 100 : null
  };
}

export async function technicianStanding(actorId: string, db: Queryable = pool): Promise<Standing> {
  const [ratings, jobs] = await Promise.all([
    db.query('select count(*)::int as n, coalesce(sum(stars),0)::int as total from provider_ratings where actor_id=$1', [actorId]),
    db.query(
      `select count(*) filter (where done)::int as completed, count(*)::int as settled
         from (select exists(select 1 from diagnostic_findings df where df.case_id=mo.case_id and df.diagnostic_actor_id=$1) as done, mo.responded_at
                 from matches_offers mo where mo.actor_id=$1 and mo.outcome='accepted') jobs
        where done or responded_at < now() - interval '48 hours'`,
      [actorId]
    )
  ]);
  return standingFrom(ratings.rows[0].total, ratings.rows[0].n, jobs.rows[0].completed, jobs.rows[0].settled);
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function pointOf(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const lat = Number(v.lat ?? v.latitude);
  const lng = Number(v.lng ?? v.lon ?? v.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const OPEN_STATES = ['intake', 'triage', 'diagnostic_pending'];

/** Opens a case to nearby technicians. Returns the existing listing if it is already open. */
export async function publishOpenJob(principal: Principal, caseId: string) {
  const current = await pool.query(
    `select sc.id, sc.state, sc.demand_id, d.location, d.urgency, d.demand_type,
            v.year, v.make, v.model, v.fuel_type, v.drivetrain
       from service_cases sc
       join demand_requests d on d.id = sc.demand_id
       left join customer_vehicles v on v.id = sc.vehicle_id
      where sc.id = $1`,
    [caseId]
  );
  const c = current.rows[0];
  if (!c) throw new Error('case_not_found');
  if (!OPEN_STATES.includes(c.state)) throw new Error('case_not_open_for_diagnostics');
  const where = pointOf(c.location);
  if (!where) throw new Error('open_job_location_missing');
  const existing = await pool.query(`select * from open_jobs where case_id=$1 and state='open'`, [caseId]);
  if (existing.rowCount) return existing.rows[0];
  const live = await pool.query(`select 1 from matches_offers where case_id=$1 and outcome in ('offered','accepted') limit 1`, [caseId]);
  if (live.rowCount) throw new Error('case_has_live_offer');

  // An open job waits in diagnostic_pending, the same place Ops' "request diagnosis" puts it.
  if (c.state === 'intake') await transitionCase(SYSTEM, caseId, 'triage');
  if (c.state !== 'diagnostic_pending') await transitionCase(SYSTEM, caseId, 'diagnostic_pending');

  const ranked = rankJob({ year: c.year, make: c.make, model: c.model, fuelType: c.fuel_type, drivetrain: c.drivetrain, demandType: c.demand_type, urgency: c.urgency });
  try {
    const r = await pool.query(
      `insert into open_jobs(case_id,demand_id,job_rank,job_score,rank_reasons,urgency,lat,lng,published_by_role,published_by_actor_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [caseId, c.demand_id, ranked.rank, ranked.score, JSON.stringify(ranked.reasons), c.urgency ?? 'normal', where.lat, where.lng, principal.role, principal.actorId ?? null]
    );
    await pool.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_role,payload) values('service_case',$1,'OPEN_JOB_PUBLISHED',$2,$3)`,
      [caseId, principal.role, JSON.stringify({ openJobId: r.rows[0].id, jobRank: ranked.rank, jobScore: ranked.score })]);
    await audit(principal, 'publish_open_job', 'open_job', r.rows[0].id, 'open_job_board', { caseId, jobRank: ranked.rank });
    return r.rows[0];
  } catch (error) {
    // Published concurrently: return the listing that won.
    if ((error as { code?: string }).code === '23505') return (await pool.query(`select * from open_jobs where case_id=$1 and state='open'`, [caseId])).rows[0];
    throw error;
  }
}

export async function withdrawOpenJob(caseId: string, reason: string, db: Queryable = pool) {
  const r = await db.query(
    `update open_jobs set state='withdrawn', withdrawn_at=now(), withdrawn_reason=$2 where case_id=$1 and state='open' returning *`,
    [caseId, reason]
  );
  return r.rows[0] ?? null;
}

export async function openJobForCase(caseId: string) {
  const r = await pool.query(
    `select o.*, coalesce(a.attributes->>'displayName', a.attributes->>'name') as claimed_by_name
       from open_jobs o left join actors a on a.id = o.claimed_by_actor_id
      where o.case_id=$1 order by o.published_at desc limit 1`,
    [caseId]
  );
  return r.rows[0] ?? null;
}

function vehicleSummary(row: { year?: number | null; make?: string | null; model?: string | null }) {
  return [row.year, row.make, row.model].filter(Boolean).join(' ') || null;
}

/** Open jobs this technician can see and claim right now, best first, plus their own standing. */
export async function listOpenJobs(principal: Principal, here: { lat: number; lng: number } | null) {
  if (principal.role !== 'diagnostic' || !principal.actorId) throw new Error('forbidden');
  const standing = await technicianStanding(principal.actorId);
  if (!here) return { standing, jobs: [], radiusKm: RADIUS_KM, locationRequired: true };
  const r = await pool.query(
    `select o.id, o.case_id, o.job_rank, o.job_score, o.urgency, o.lat, o.lng, o.published_at, d.demand_type,
            v.year, v.make, v.model
       from open_jobs o
       join demand_requests d on d.id = o.demand_id
       join service_cases sc on sc.id = o.case_id
       left join customer_vehicles v on v.id = sc.vehicle_id
      where o.state = 'open'`
  );
  const now = Date.now();
  const order: Record<JobRank, number> = { premium: 0, standard: 1, basic: 2 };
  // Jobs whose case requires qualifications this technician does not hold are not shown at all.
  const gated = await casesWithRequirements(r.rows.map((o) => o.case_id));
  const blocked = new Set<string>();
  for (const caseId of gated) {
    if ((await qualificationBlockingReasons(caseId, principal.actorId)).length) blocked.add(caseId);
  }
  const jobs = r.rows
    .filter((o) => !blocked.has(o.case_id))
    .map((o) => {
      const delay = releaseDelaySeconds(o.job_rank, standing.tier, o.urgency);
      const openAt = new Date(o.published_at).getTime() + delay * 1000;
      const km = distanceKm(here, { lat: Number(o.lat), lng: Number(o.lng) });
      return {
        jobId: o.id as string,
        issueType: o.demand_type as string,
        urgency: o.urgency as string,
        jobRank: o.job_rank as JobRank,
        vehicle: vehicleSummary(o),
        // Rough distance only, to the nearest half kilometre: the exact location comes with the claim.
        distanceKm: Math.max(0.5, Math.round(km * 2) / 2),
        postedAt: o.published_at as string,
        earlyAccess: delay < releaseDelaySeconds(o.job_rank, 'bronze', o.urgency),
        _km: km,
        _openAt: openAt
      };
    })
    .filter((j) => j._km <= RADIUS_KM && j._openAt <= now)
    .sort((a, b) => order[a.jobRank] - order[b.jobRank] || a._km - b._km)
    .map(({ _km, _openAt, ...job }) => job);
  return { standing, jobs, radiusKm: RADIUS_KM, locationRequired: false };
}

/** Claims an open job: first claim wins, and it becomes the technician's accepted job. */
export async function claimOpenJob(principal: Principal, jobId: string, here: { lat: number; lng: number } | null) {
  if (principal.role !== 'diagnostic' || !principal.actorId) throw new Error('forbidden');
  if (!here) throw new Error('location_required');
  const actorId = principal.actorId;
  const standing = await technicianStanding(actorId);
  const client = await pool.connect();
  let claimed: { caseId: string; offerId: string; jobRank: JobRank } | null = null;
  try {
    await client.query('begin');
    const actor = await client.query(`select status from actors where id=$1`, [actorId]);
    if (actor.rows[0]?.status !== 'active') throw new Error('forbidden');
    const jobRow = await client.query(`select * from open_jobs where id=$1 for update`, [jobId]);
    const job = jobRow.rows[0];
    if (!job) throw new Error('open_job_not_found');
    if (job.state !== 'open') throw new Error('open_job_taken');
    if (Date.now() < new Date(job.published_at).getTime() + releaseDelaySeconds(job.job_rank, standing.tier, job.urgency) * 1000) throw new Error('open_job_not_yet_available');
    if (distanceKm(here, { lat: Number(job.lat), lng: Number(job.lng) }) > RADIUS_KM) throw new Error('open_job_too_far');

    const sc = await client.query(`select id, state from service_cases where id=$1 for update`, [job.case_id]);
    const live = await client.query(`select 1 from matches_offers where case_id=$1 and outcome in ('offered','accepted') limit 1`, [job.case_id]);
    if (sc.rows[0]?.state !== 'diagnostic_pending' || live.rowCount) {
      await client.query(`update open_jobs set state='withdrawn', withdrawn_at=now(), withdrawn_reason='case_moved_on' where id=$1`, [jobId]);
      await client.query('commit');
      throw new Error('open_job_taken');
    }
    await assertQualified(job.case_id, actorId, client);
    const offer = await client.query(
      `insert into matches_offers(demand_id,case_id,actor_id,score,rank,rule_basis,outcome,responded_at)
       values($1,$2,$3,$4,1,$5,'accepted',now()) returning id`,
      [job.demand_id, job.case_id, actorId, standing.score, `open_job_claim:${job.job_rank}:${standing.tier}`]
    );
    await client.query(`update open_jobs set state='claimed', claimed_by_actor_id=$2, claimed_at=now(), offer_id=$3 where id=$1`, [jobId, actorId, offer.rows[0].id]);
    await client.query(`update service_cases set current_owner_role='diagnostic', current_owner_actor_id=$2, updated_at=now() where id=$1`, [job.case_id, actorId]);
    await client.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload) values('service_case',$1,'OPEN_JOB_CLAIMED',$2,'diagnostic',$3)`,
      [job.case_id, actorId, JSON.stringify({ openJobId: jobId, offerId: offer.rows[0].id, jobRank: job.job_rank, tier: standing.tier })]);
    await client.query('commit');
    claimed = { caseId: job.case_id, offerId: offer.rows[0].id, jobRank: job.job_rank };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // Same as accepting an offered job: the technician's work starts now.
  try { await transitionCase(principal, claimed.caseId, 'diagnostic_in_progress'); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'invalid_case_transition' && message !== 'transition_forbidden') console.error('open_job_claim_transition_failed', { caseId: claimed.caseId, message });
  }
  await audit(principal, 'claim_open_job', 'open_job', jobId, 'open_job_board', { caseId: claimed.caseId, tier: standing.tier });
  return { ...claimed, tier: standing.tier };
}

/** Providers the customer can rate on a case: those who accepted work on it, with any rating given. */
export async function rateableProviders(principal: Principal, caseId: string) {
  const owns = await pool.query('select 1 from service_cases where id=$1 and customer_actor_id=$2', [caseId, principal.actorId ?? null]);
  if (principal.role !== 'customer' || !owns.rowCount) throw new Error('case_not_found');
  const r = await pool.query(
    `select distinct on (mo.actor_id) mo.actor_id, a.actor_type,
            coalesce(a.attributes->>'displayName', a.attributes->>'name') as name,
            pr.stars, pr.comment,
            (exists(select 1 from diagnostic_findings df where df.case_id=mo.case_id and df.diagnostic_actor_id=mo.actor_id)
              or (select state from service_cases where id=mo.case_id) in ('completed','closed')) as ready
       from matches_offers mo
       join actors a on a.id = mo.actor_id
       left join provider_ratings pr on pr.case_id = mo.case_id and pr.actor_id = mo.actor_id
      where mo.case_id=$1 and mo.outcome='accepted'
      order by mo.actor_id, mo.responded_at desc`,
    [caseId]
  );
  return r.rows.map((p) => ({ actorId: p.actor_id, role: p.actor_type, name: p.name, stars: p.stars, comment: p.comment, canRate: Boolean(p.ready) }));
}

export async function rateProvider(principal: Principal, caseId: string, actorId: string, stars: number, comment?: string) {
  const providers = await rateableProviders(principal, caseId);
  const provider = providers.find((p) => p.actorId === actorId);
  if (!provider) throw new Error('provider_not_on_case');
  if (!provider.canRate) throw new Error('rating_too_early');
  const r = await pool.query(
    `insert into provider_ratings(case_id,actor_id,customer_actor_id,stars,comment) values($1,$2,$3,$4,$5)
     on conflict (case_id, actor_id) do update set stars=excluded.stars, comment=excluded.comment, created_at=now()
     returning *`,
    [caseId, actorId, principal.actorId, stars, comment?.trim() || null]
  );
  await audit(principal, 'rate_provider', 'provider_rating', r.rows[0].id, 'customer_rating', { caseId, actorId, stars });
  return r.rows[0];
}
