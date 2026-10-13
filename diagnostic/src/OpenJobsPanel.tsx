import { useEffect, useState } from 'react';

// "Open jobs near you": cases Ops has opened to nearby technicians, Uber-style. Each job carries a
// rank (premium / standard / basic) from the vehicle and the work; the technician's own rank
// (gold / silver / bronze) decides how early they see the better jobs. First claim wins.

export type Standing = { tier: 'gold' | 'silver' | 'bronze'; score: number; ratingAverage: number | null; ratingCount: number; completedJobs: number; completionRate: number | null };
export type OpenJob = { jobId: string; issueType: string; urgency: string; jobRank: 'premium' | 'standard' | 'basic'; vehicle: string | null; distanceKm: number; postedAt: string; earlyAccess: boolean };
type Board = { standing: Standing; jobs: OpenJob[]; radiusKm: number; locationRequired: boolean };

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = 'roviq_diagnostic_token';
const ERRORS: Record<string, string> = {
  open_job_taken: 'Another technician claimed this job first.',
  open_job_not_yet_available: 'Higher-ranked technicians still have first pick on this job. Try again in a minute.',
  open_job_too_far: 'This job is too far from where you are.',
  location_required: 'Allow location access to claim jobs near you.'
};
const TIER_LABEL = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };
const RANK_LABEL = { premium: 'Premium', standard: 'Standard', basic: 'Basic' };

export function here(): Promise<{ lat: number; lng: number } | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => resolve(null),
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 6000 }
  ));
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem(TOKEN) ?? ''}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request_failed_${res.status}`);
  return body as T;
}

/** Claims an open job from where the technician is now. Returns the claimed case id. */
export async function claimOpenJob(jobId: string): Promise<string> {
  const location = await here();
  const r = await call<{ claim: { caseId: string } }>(`/api/diagnostics/open-jobs/${jobId}/claim`, { method: 'POST', body: JSON.stringify(location ?? {}) });
  return r.claim.caseId;
}

export function claimError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return ERRORS[code] ?? 'Could not claim this job. Try again.';
}

function label(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function age(postedAt: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(postedAt).getTime()) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export function OpenJobsPanel({ onClaimed }: { onClaimed: (caseId: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const location = await here();
      const q = location ? `?lat=${location.lat}&lng=${location.lng}` : '';
      setBoard(await call<Board>(`/api/diagnostics/open-jobs${q}`));
    } catch {
      /* keep the last board; it refreshes again shortly */
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(timer);
  }, []);

  async function claim(jobId: string) {
    setBusy(true);
    setError('');
    try {
      const caseId = await claimOpenJob(jobId);
      setConfirming(null);
      onClaimed(caseId);
    } catch (err) {
      setError(claimError(err));
      setConfirming(null);
    } finally {
      setBusy(false);
      void load();
    }
  }

  if (!board) return null;
  const { standing } = board;
  return (
    <section className="panel open-jobs" aria-labelledby="open-jobs-heading">
      <div className="section-head">
        <div>
          <span className="eyebrow">Open jobs near you</span>
          <h2 id="open-jobs-heading">{board.jobs.length ? `${board.jobs.length} job${board.jobs.length === 1 ? '' : 's'} within ${board.radiusKm} km` : 'No open jobs right now'}</h2>
        </div>
        <span className={`tier tier-${standing.tier}`} title={`Rank score ${standing.score}/100`}>{TIER_LABEL[standing.tier]}</span>
      </div>
      <p className="hint">
        {standing.tier === 'gold' ? 'You see premium jobs first.' : 'Gold technicians get first pick on premium jobs. Good ratings and finished jobs raise your rank.'}
        {standing.ratingAverage != null ? ` Rating ${standing.ratingAverage}★ from ${standing.ratingCount}.` : ''} {standing.completedJobs} jobs finished.
      </p>
      {board.locationRequired && <p className="hint" role="status">Allow location access to see jobs near you.</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {board.jobs.length > 0 && (
        <ul className="open-job-list">
          {board.jobs.map((job) => (
            <li key={job.jobId} className={`open-job rank-${job.jobRank}`}>
              <div>
                <span className={`rank rank-${job.jobRank}`}>{RANK_LABEL[job.jobRank]}</span>
                {job.urgency !== 'normal' && <span className="pill">{label(job.urgency)}</span>}
                {job.earlyAccess && <span className="pill">Early access</span>}
                <h3>{label(job.issueType)}</h3>
                <p>{job.vehicle ?? 'Vehicle not given'} · about {job.distanceKm} km · {age(job.postedAt)}</p>
              </div>
              {confirming === job.jobId ? (
                <div className="actions">
                  <button type="button" className="primary" disabled={busy} aria-busy={busy} onClick={() => void claim(job.jobId)}>{busy ? 'Claiming…' : 'Confirm claim'}</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="primary" disabled={busy} onClick={() => setConfirming(job.jobId)}>Claim</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
