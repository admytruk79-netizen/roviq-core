import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import { CASE_STATES, type ServiceCase } from '../lib/types';

export function Cases() {
  const [cases, setCases] = useState<ServiceCase[] | null>(null);
  const [stateFilter, setStateFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCases(null);
    const query = stateFilter ? `?state=${stateFilter}` : '';
    api
      .get<{ cases: ServiceCase[] }>(`/api/admin/cases${query}`)
      .then((res) => setCases(res.cases))
      .catch(() => setError('Could not load cases.'));
  }, [stateFilter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Cases</h1>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
        >
          <option value="">All states</option>
          {CASE_STATES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {cases === null && !error && <p className="text-sm text-slate-500">Loading…</p>}

      {cases !== null && cases.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No cases match this filter.
        </p>
      )}

      {cases !== null && cases.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {cases.map((c) => (
            <li key={c.id}>
              <Link to={`/cases/${c.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-slate-50">
                <div>
                  <p className="text-sm font-medium capitalize">{c.case_type} case</p>
                  <p className="text-xs text-slate-500">Updated {formatDateTime(c.updated_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase text-slate-400">{c.priority}</span>
                  <StatusBadge state={c.state} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
