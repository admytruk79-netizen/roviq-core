import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, humanizeToken } from '../lib/format';

// Ops control for the open job board: open a case to nearby technicians (first claim wins, better
// ranked technicians see better jobs first), see its rank and who claimed it, or take it back.

type OpenJob = {
  id: string; state: 'open' | 'claimed' | 'withdrawn'; job_rank: 'premium' | 'standard' | 'basic'; job_score: number; rank_reasons: string[];
  published_at: string; claimed_at: string | null; claimed_by_name: string | null; withdrawn_reason: string | null;
};

const ERRORS: Record<string, string> = {
  open_job_location_missing: 'This case has no vehicle location, so nearby technicians cannot be found. Add the location first.',
  case_has_live_offer: 'A provider already has an offer on this case. Withdraw it before opening the case to nearby technicians.',
  case_not_open_for_diagnostics: 'This case has moved past diagnostics.'
};
const RANK_STYLE = { premium: 'bg-[var(--roviq-copper,#E46F35)] text-white', standard: 'bg-slate-500 text-white', basic: 'bg-slate-100 text-slate-700' };

export function OpenJobControl({ caseId, caseState, onChange }: { caseId: string; caseState: string; onChange: () => void }) {
  const [job, setJob] = useState<OpenJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setJob((await api.get<{ openJob: OpenJob | null }>(`/api/admin/cases/${caseId}/open-job`)).openJob); } catch { /* keep last */ }
  }, [caseId]);
  useEffect(() => { void load(); }, [load, caseState]);

  async function act(kind: 'publish' | 'withdraw') {
    setBusy(true); setError(null);
    try {
      if (kind === 'publish') await api.post(`/api/admin/cases/${caseId}/open-job`, {});
      else await api.delete(`/api/admin/cases/${caseId}/open-job`);
      await load(); onChange();
    } catch (err) {
      setError(err instanceof ApiError ? ERRORS[err.message] ?? 'Core rejected that. Refresh the case and try again.' : 'Could not reach Core.');
    } finally { setBusy(false); }
  }

  const canPublish = ['intake', 'triage', 'diagnostic_pending'].includes(caseState) && job?.state !== 'open';
  if (!job && !canPublish) return null;
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="open-job-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="open-job-heading" className="text-sm font-semibold text-slate-700">Open to nearby technicians</h2>
        {job && <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${RANK_STYLE[job.job_rank]}`}>{humanizeToken(job.job_rank)} · {job.job_score}/100</span>}
      </div>
      {job?.state === 'open' && <p className="mt-2 text-sm text-slate-600">On the job board since {formatDateTime(job.published_at)}. {job.job_rank === 'basic' ? 'All technicians within 50 km can claim it.' : 'Gold technicians see it first, then silver and bronze.'}</p>}
      {job?.state === 'claimed' && <p className="mt-2 text-sm text-emerald-700">Claimed by {job.claimed_by_name ?? 'a diagnostic technician'}{job.claimed_at ? ` at ${formatDateTime(job.claimed_at)}` : ''}.</p>}
      {job?.state === 'withdrawn' && <p className="mt-2 text-sm text-slate-500">Taken off the board ({humanizeToken(job.withdrawn_reason ?? 'withdrawn')}).</p>}
      {job && job.rank_reasons.length > 0 && <p className="mt-1 text-xs text-slate-500">Rank: {job.rank_reasons.join(' · ')}</p>}
      {!job && <p className="mt-2 text-sm text-slate-500">Instead of choosing a technician, let nearby technicians claim it. ROVIQ ranks the job from the vehicle and the work, and better-ranked technicians see better jobs first.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {canPublish && <button type="button" className="roviq-btn-primary" disabled={busy} aria-busy={busy} onClick={() => void act('publish')}>{busy ? 'Opening…' : 'Open to nearby technicians'}</button>}
        {job?.state === 'open' && <button type="button" className="roviq-btn-secondary" disabled={busy} onClick={() => void act('withdraw')}>Take off the board</button>}
      </div>
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
    </section>
  );
}
