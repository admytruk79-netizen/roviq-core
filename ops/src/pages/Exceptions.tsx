import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDateTime, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type { CaseException } from '../lib/types';

// gray-*, not slate-*: see the comment in StatusBadge.tsx -- the dark-theme retheme force-lightens
// every text-slate-* utility but leaves bg-slate-* alone, which turns a slate-on-slate pill
// illegible (near-white text on a near-white background).
const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  warning: 'bg-amber-100 text-amber-800',
  info: 'bg-gray-200 text-gray-800'
};

export function Exceptions() {
  const [exceptions, setExceptions] = useState<CaseException[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    // The v2 endpoint only filters on one exact state, so fetch everything and keep every
    // non-terminal one client-side -- otherwise acknowledging or starting remediation on an
    // exception (a state this same page can put it into) makes it vanish from "Open exceptions"
    // with no way to find it again, even though nobody resolved or dismissed it yet.
    return api
      .get<{ exceptions: CaseException[] }>('/api/admin/exceptions/v2')
      .then((res) => setExceptions(res.exceptions.filter((e) => e.state !== 'resolved' && e.state !== 'dismissed')))
      .catch(() => setError('Could not load exceptions.'));
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function acknowledge(id: string) {
    setActingId(id);
    setActionError(null);
    try {
      await api.post(`/api/admin/exceptions/${id}/state`, { state: 'acknowledged' });
      await load();
    } catch {
      setActionError('Could not acknowledge this exception.');
    } finally {
      setActingId(null);
    }
  }

  async function dismiss(id: string) {
    if (!window.confirm('Dismiss this exception without resolving the underlying issue?')) return;
    setActingId(id);
    setActionError(null);
    try {
      await api.post(`/api/admin/exceptions/${id}/state`, { state: 'dismissed' });
      await load();
    } catch {
      setActionError('Could not dismiss this exception.');
    } finally {
      setActingId(null);
    }
  }

  async function resolve(id: string) {
    const resolutionCode = window.prompt('Resolution code (e.g. FIXED_MANUALLY, CUSTOMER_CONTACTED):');
    if (!resolutionCode || !resolutionCode.trim()) return;
    setActingId(id);
    setActionError(null);
    try {
      await api.post(`/api/admin/exceptions/${id}/state`, { state: 'resolved', resolutionCode: resolutionCode.trim() });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError && err.status === 409 ? 'That exception can no longer move to resolved from its current state.' : 'Could not resolve this exception.');
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Open exceptions</h1>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {actionError && <p className="text-sm text-red-600" role="alert">{actionError}</p>}
      {exceptions === null && !error && <p className="text-sm text-slate-500">Loading…</p>}
      {exceptions !== null && exceptions.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No open exceptions.
        </p>
      )}

      {exceptions !== null && exceptions.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {exceptions.map((e) => (
            <li key={e.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <Link to={`/cases/${e.case_id}`} className="text-sm font-medium hover:underline">{e.summary}</Link>
                <p className="text-xs text-slate-500">{humanizeToken(e.exception_code)} · Case state: {humanizeToken(e.case_state)} · {formatDateTime(e.created_at)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${SEVERITY_COLORS[e.severity] ?? SEVERITY_COLORS.info}`}>
                  {e.severity}
                </span>
                <StatusBadge state={e.case_state} />
                <span className="inline-flex items-center rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-medium capitalize text-slate-600">{humanizeToken(e.state)}</span>
                {e.state === 'open' && (
                  <button type="button" disabled={actingId === e.id} onClick={() => void acknowledge(e.id)} className="min-h-9 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                    {actingId === e.id ? 'Working…' : 'Acknowledge'}
                  </button>
                )}
                <button type="button" disabled={actingId === e.id} onClick={() => void resolve(e.id)} className="min-h-9 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                  {actingId === e.id ? 'Working…' : 'Resolve'}
                </button>
                <button type="button" disabled={actingId === e.id} onClick={() => void dismiss(e.id)} className="min-h-9 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  {actingId === e.id ? 'Working…' : 'Dismiss'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
