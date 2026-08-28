import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateTime, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type { CaseException } from '../lib/types';

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  warning: 'bg-amber-100 text-amber-800',
  info: 'bg-slate-100 text-slate-700'
};

export function Exceptions() {
  const [exceptions, setExceptions] = useState<CaseException[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ exceptions: CaseException[] }>('/api/admin/exceptions')
      .then((res) => setExceptions(res.exceptions))
      .catch(() => setError('Could not load exceptions.'));
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Open exceptions</h1>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {exceptions === null && !error && <p className="text-sm text-slate-500">Loading…</p>}
      {exceptions !== null && exceptions.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No open exceptions.
        </p>
      )}

      {exceptions !== null && exceptions.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {exceptions.map((e) => (
            <li key={e.id}>
              <Link to={`/cases/${e.case_id}`} className="flex items-center justify-between px-4 py-3 hover:bg-slate-50">
                <div>
                  <p className="text-sm font-medium">{e.summary}</p>
                  <p className="text-xs text-slate-500">{humanizeToken(e.code)} · Case state: {humanizeToken(e.case_state)} · {formatDateTime(e.created_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${SEVERITY_COLORS[e.severity] ?? SEVERITY_COLORS.info}`}>
                    {e.severity}
                  </span>
                  <StatusBadge state={e.case_state} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
