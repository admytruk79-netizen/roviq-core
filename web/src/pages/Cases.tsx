import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type { ServiceCase } from '../lib/types';

export function Cases() {
  const [cases, setCases] = useState<ServiceCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ cases: ServiceCase[] }>('/api/customers/me/cases')
      .then((res) => setCases(res.cases))
      .catch(() => setError('Could not load your cases.'));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Your cases</h1>
        <Link to="/cases/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800">
          Report a new issue
        </Link>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {cases === null && !error && <p className="text-sm text-slate-500">Loading…</p>}

      {cases !== null && cases.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No cases yet. Report an issue to get started.
        </p>
      )}

      {cases !== null && cases.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {cases.map((c) => (
            <li key={c.id}>
              <Link to={`/cases/${c.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-slate-50">
                <div>
                  <p className="text-sm font-medium capitalize">{c.case_type} case</p>
                  <p className="text-xs text-slate-500">Opened {formatDateTime(c.created_at)}</p>
                </div>
                <StatusBadge state={c.state} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
