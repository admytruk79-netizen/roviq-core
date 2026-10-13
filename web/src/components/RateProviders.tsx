import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

// "Rate your technician": once someone has finished work on the case, the customer gives 1-5 stars.
// Ratings feed the technician's rank, and better-ranked technicians get first pick of new jobs.

type Provider = { actorId: string; role: string; name: string | null; stars: number | null; comment: string | null; canRate: boolean };

const ROLE: Record<string, string> = { diagnostic: 'Diagnostic technician', shop: 'Repair shop', tow: 'Tow driver', partner: 'Service provider' };

function ProviderRating({ caseId, provider, onSaved }: { caseId: string; provider: Provider; onSaved: () => void }) {
  const [stars, setStars] = useState(provider.stars ?? 0);
  const [comment, setComment] = useState(provider.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(provider.stars != null);
  const [error, setError] = useState('');
  const who = provider.name ?? ROLE[provider.role] ?? 'Your provider';

  async function save() {
    if (!stars) return;
    setBusy(true); setError('');
    try {
      await api.post(`/api/maintenance/cases/${caseId}/ratings`, { actorId: provider.actorId, stars, comment: comment.trim() || undefined });
      setSaved(true); onSaved();
    } catch { setError('Could not save your rating. Please try again.'); }
    finally { setBusy(false); }
  }

  return (
    <li className="px-4 py-3">
      <p className="text-sm font-medium text-slate-800">{who}{provider.name && ROLE[provider.role] ? <span className="font-normal text-slate-500"> · {ROLE[provider.role]}</span> : null}</p>
      <div className="mt-2 flex gap-1" role="radiogroup" aria-label={`Rate ${who}`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n === 1 ? '' : 's'}`}
            onClick={() => { setStars(n); setSaved(false); }}
            className={`min-h-11 min-w-11 rounded-md text-2xl leading-none ${n <= stars ? 'text-[var(--roviq-copper)]' : 'text-slate-300'}`}>★</button>
        ))}
      </div>
      {stars > 0 && !saved && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor={`rating-comment-${provider.actorId}`}>Comment (optional)</label>
          <input id={`rating-comment-${provider.actorId}`} value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} placeholder="Anything to add? (optional)"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button type="button" className="roviq-btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Send rating'}</button>
        </div>
      )}
      {saved && <p className="mt-1 text-xs text-emerald-700" role="status">Thanks for your rating.</p>}
      {error && <p className="mt-1 text-xs text-red-600" role="alert">{error}</p>}
    </li>
  );
}

export function RateProviders({ caseId, refreshKey }: { caseId: string; refreshKey?: unknown }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const load = useCallback(() => api.get<{ providers: Provider[] }>(`/api/maintenance/cases/${caseId}/ratings`).then((r) => setProviders(r.providers)).catch(() => setProviders([])), [caseId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const ready = providers.filter((p) => p.canRate);
  if (!ready.length) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-800">Rate your service</h2>
      <p className="mt-1 text-xs text-slate-500">Your rating helps the best technicians get the next jobs.</p>
      <ul className="mt-3 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {ready.map((p) => <ProviderRating key={p.actorId} caseId={caseId} provider={p} onSaved={() => void load()} />)}
      </ul>
    </section>
  );
}
