import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.js';
import { arrangeJobs, arrangeOpenJobs, intentFromKeywords, pointOf } from '../cloudflare/work-assist.js';

// The diagnostic technician's assistant: answers come only from the technician's own queue
// (fetched from Core with their sign-in), and accepting a job is a proposal they confirm.

afterEach(() => vi.unstubAllGlobals());

const here = { lat: 45.52, lng: -122.68 };
const queue = [
  { offer_id: 'o-far', case_id: 'c1', demand_type: 'flat_tire', urgency: 'normal', outcome: 'offered', offered_at: '2026-10-03T10:00:00Z', location: { lat: 45.60, lng: -122.68 } },
  { offer_id: 'o-near', case_id: 'c2', demand_type: 'wont_start', urgency: 'urgent', outcome: 'offered', offered_at: '2026-10-03T09:00:00Z', location: { lat: 45.53, lng: -122.68 } },
  { offer_id: 'o-mine', case_id: 'c3', demand_type: 'battery', urgency: 'emergency', outcome: 'accepted', offered_at: '2026-10-03T08:00:00Z', location: { coordinates: [-122.70, 45.55] } }
];

function stubCore(role = 'diagnostic') {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${url} ${(init?.headers as Record<string, string>)?.authorization ?? ''}`);
    if (url.endsWith('/api/auth/roles')) return new Response(JSON.stringify({ active: { role, actorId: 'tech-1' } }), { status: 200 });
    if (url.endsWith('/api/diagnostics/me/queue')) return new Response(JSON.stringify({ queue }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
  return calls;
}

const ask = (message: string, extra: Record<string, unknown> = {}, env: Record<string, unknown> = {}) => worker.fetch(new Request('https://core.test/api/assist/work', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tech-token' }, body: JSON.stringify({ message, location: here, ...extra })
}), { CORE_API_URL: 'https://core.invalid', ...env }, { waitUntil: vi.fn() });

describe('job arrangement', () => {
  it('reads every stored location shape and sorts by distance, urgency or recency', () => {
    expect(pointOf({ coordinates: [-122.7, 45.55] })).toEqual({ lat: 45.55, lng: -122.7 });
    expect(pointOf({ latitude: '45.5', longitude: '-122.6' })).toEqual({ lat: 45.5, lng: -122.6 });
    expect(pointOf({ lat: 200, lng: 0 })).toBeNull();
    expect(arrangeJobs(queue, here, 'nearest', 'all').map((j) => j.offerId)).toEqual(['o-near', 'o-mine', 'o-far']);
    expect(arrangeJobs(queue, here, 'urgent', 'all').map((j) => j.offerId)).toEqual(['o-mine', 'o-near', 'o-far']);
    expect(arrangeJobs(queue, here, 'newest', 'offered').map((j) => j.offerId)).toEqual(['o-far', 'o-near']);
    expect(arrangeJobs(queue, null, 'nearest', 'all').every((j) => j.distanceKm === null)).toBe(true);
  });

  it('understands requests without the AI', () => {
    expect(intentFromKeywords('show me the nearest cases')).toMatchObject({ intent: 'list', sort: 'nearest' });
    expect(intentFromKeywords('anything urgent?')).toMatchObject({ intent: 'list', sort: 'urgent' });
    expect(intentFromKeywords('take the closest one')).toMatchObject({ intent: 'accept', job: 'closest' });
    expect(intentFromKeywords('accept job 2')).toMatchObject({ intent: 'accept', job: 2 });
    expect(intentFromKeywords('pass on 3')).toMatchObject({ intent: 'decline', job: 3 });
    expect(intentFromKeywords('tell me about job 1')).toMatchObject({ intent: 'details', job: 1 });
  });
});

describe('diagnostic assistant', () => {
  it('lists the technician’s own jobs nearest first, fetched with their own sign-in', async () => {
    const calls = stubCore();
    const res = await ask('show me the nearest cases');
    expect(res.status).toBe(200);
    const body = await res.json() as { reply: string; jobs: Array<{ offerId: string; distanceKm: number }>; reader: string };
    expect(body.reader).toBe('keywords');
    expect(body.jobs.map((j) => j.offerId)).toEqual(['o-near', 'o-mine', 'o-far']);
    expect(body.jobs[0].distanceKm).toBeCloseTo(1.1, 1);
    expect(body.reply).toMatch(/^3 jobs, nearest first: 1\. Won’t start \(urgent\), 1\.1 km away · new offer/);
    expect(calls.some((c) => c.includes('/api/diagnostics/me/queue Bearer tech-token'))).toBe(true);
  });

  it('prepares accepting the closest offer as a proposal to confirm, never acting itself', async () => {
    const calls = stubCore();
    const body = await (await ask('take the closest one')).json() as { proposal: Record<string, string>; reply: string };
    expect(body.proposal).toMatchObject({ action: 'respond_offer', offerId: 'o-near', outcome: 'accepted' });
    expect(body.reply).toMatch(/Confirm below/);
    expect(calls.some((c) => c.includes('/respond'))).toBe(false);
  });

  it('resolves "job N" against the list the technician last saw and refuses already accepted jobs', async () => {
    stubCore();
    const seen = ['o-near', 'o-mine', 'o-far'];
    const third = await (await ask('accept job 3', { lastJobs: seen })).json() as { proposal: { offerId: string } };
    expect(third.proposal.offerId).toBe('o-far');
    const taken = await (await ask('accept job 2', { lastJobs: seen })).json() as { proposal?: unknown; reply: string };
    expect(taken.proposal).toBeUndefined();
    expect(taken.reply).toMatch(/already accepted/);
  });

  it('uses the AI reading when available and falls back to keywords when it fails', async () => {
    stubCore();
    const ai = { run: vi.fn().mockResolvedValue({ response: '{"intent":"list","sort":"urgent","filter":"all","job":null}' }) };
    const urgent = await (await ask('what should I do first?', {}, { AI: ai })).json() as { jobs: Array<{ offerId: string }>; reader: string };
    expect(urgent.reader).toBe('ai');
    expect(urgent.jobs[0].offerId).toBe('o-mine');
    const broken = { run: vi.fn().mockRejectedValue(new Error('down')) };
    expect(((await (await ask('show me the nearest cases', {}, { AI: broken })).json()) as { reader: string }).reader).toBe('keywords');
  });

  it('needs a signed-in user and only serves diagnostic jobs to diagnostic technicians', async () => {
    const unsigned = await worker.fetch(new Request('https://core.test/api/assist/work', { method: 'POST', body: '{"message":"hi"}' }), { CORE_API_URL: 'https://core.invalid' }, { waitUntil: vi.fn() });
    expect(unsigned.status).toBe(401);
    const calls = stubCore('tow');
    const body = await (await ask('show me the nearest cases')).json() as { jobs: unknown[] };
    expect(body.jobs).toEqual([]);
    expect(calls.some((c) => c.includes('/api/diagnostics/me/queue'))).toBe(false);
  });
});

describe('open job board through the assistant', () => {
  const board = {
    standing: { tier: 'gold' },
    radiusKm: 50,
    jobs: [
      { jobId: 'j-basic', issueType: 'oil_change', urgency: 'normal', jobRank: 'basic', vehicle: '2010 Toyota Corolla', distanceKm: 2 },
      { jobId: 'j-premium-far', issueType: 'check_engine_light', urgency: 'normal', jobRank: 'premium', vehicle: '2025 Porsche Cayenne', distanceKm: 12 },
      { jobId: 'j-premium-near', issueType: 'transmission', urgency: 'urgent', jobRank: 'premium', vehicle: '2024 BMW X5', distanceKm: 4.5 }
    ]
  };
  function stubBoard() {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/auth/roles')) return new Response(JSON.stringify({ active: { role: 'diagnostic', actorId: 'tech-1' } }), { status: 200 });
      if (url.includes('/api/diagnostics/open-jobs')) return new Response(JSON.stringify(board), { status: 200 });
      if (url.endsWith('/api/diagnostics/me/queue')) return new Response(JSON.stringify({ queue: [] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    return urls;
  }

  it('reads open-job requests without the AI', () => {
    expect(intentFromKeywords('any open jobs near me?')).toMatchObject({ intent: 'open_jobs' });
    expect(intentFromKeywords('show premium jobs')).toMatchObject({ intent: 'open_jobs', rank: 'premium' });
    expect(intentFromKeywords('claim the closest premium job')).toMatchObject({ intent: 'claim', job: 'closest', rank: 'premium' });
    expect(intentFromKeywords('claim job 2')).toMatchObject({ intent: 'claim', job: 2 });
    expect(intentFromKeywords('take the closest one')).toMatchObject({ intent: 'accept' });
  });

  it('sorts open jobs best rank first, then nearest', () => {
    expect(arrangeOpenJobs(board.jobs, null).map((j) => j.jobId)).toEqual(['j-premium-near', 'j-premium-far', 'j-basic']);
    expect(arrangeOpenJobs(board.jobs, 'basic').map((j) => j.jobId)).toEqual(['j-basic']);
  });

  it('lists open jobs from Core with the technician’s location and rank', async () => {
    const urls = stubBoard();
    const body = await (await ask('any open jobs near me?')).json() as { reply: string; jobs: Array<{ jobId: string }> };
    expect(urls.some((u) => u.includes('/api/diagnostics/open-jobs?lat=45.52&lng=-122.68'))).toBe(true);
    expect(body.jobs.map((j) => j.jobId)).toEqual(['j-premium-near', 'j-premium-far', 'j-basic']);
    expect(body.reply).toMatch(/3 open jobs within 50 km/);
    expect(body.reply).toMatch(/Gold/);
  });

  it('prepares a claim the technician confirms, and never claims by itself', async () => {
    const urls = stubBoard();
    const body = await (await ask('claim the closest premium job')).json() as { proposal: { action: string; jobId: string } };
    expect(body.proposal).toMatchObject({ action: 'claim_open_job', jobId: 'j-premium-near' });
    expect(urls.some((u) => u.includes('/claim'))).toBe(false);
    const numbered = await (await ask('claim job 2', { lastJobs: ['j-premium-near', 'j-premium-far', 'j-basic'] })).json() as { proposal: { jobId: string } };
    expect(numbered.proposal.jobId).toBe('j-premium-far');
    // Nothing offered directly: "take the closest one" means the closest open job.
    const fallback = await (await ask('take the closest one')).json() as { proposal: { action: string; jobId: string } };
    expect(fallback.proposal).toMatchObject({ action: 'claim_open_job', jobId: 'j-basic' });
  });

  it('asks for location before looking for open jobs', async () => {
    stubBoard();
    const body = await (await ask('any open jobs near me?', { location: null })).json() as { reply: string };
    expect(body.reply).toMatch(/location/);
  });
});
