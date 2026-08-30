import { useEffect, useMemo, useState } from 'react';
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
    api.get<{ cases: ServiceCase[] }>(`/api/admin/cases${query}`).then((res) => setCases(res.cases)).catch(() => setError('Could not load cases.'));
  }, [stateFilter]);

  const critical = useMemo(() => cases?.filter(c => ['critical','emergency','high'].includes(String(c.priority).toLowerCase())).length ?? 0,[cases]);
  const active = useMemo(() => cases?.filter(c => !['closed','completed','cancelled'].includes(String(c.state).toLowerCase())).length ?? 0,[cases]);

  return (
    <div className="space-y-5">
      <section className="ops-hero">
        <div><p className="roviq-kicker">Network control</p><h1>Operations cases</h1><p className="roviq-muted">Monitor active cases, priority and exceptions from one control surface.</p></div>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="roviq-input ops-filter" aria-label="Filter cases by state">
          <option value="">All states</option>
          {CASE_STATES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </section>

      <section className="ops-stats" aria-label="Operations summary">
        <div><span>Visible cases</span><strong>{cases?.length ?? '—'}</strong></div>
        <div><span>Active</span><strong>{active}</strong></div>
        <div><span>Priority watch</span><strong>{critical}</strong></div>
      </section>

      {error && <div className="ops-error">{error}</div>}
      {cases === null && !error && <div className="roviq-panel p-5 text-sm roviq-muted">Loading operational cases…</div>}
      {cases !== null && cases.length === 0 && <div className="roviq-panel ops-empty">No cases match this filter.</div>}

      {cases !== null && cases.length > 0 && (
        <section className="ops-case-grid">
          {cases.map((c) => (
            <Link to={`/cases/${c.id}`} key={c.id} className="ops-case-card">
              <div className="ops-case-top"><div><p className="roviq-kicker">{String(c.case_type).replaceAll('_',' ')} case</p><h2>Case {c.id.slice(0,8)}</h2></div><StatusBadge state={c.state} /></div>
              <div className="ops-case-meta"><span className={`ops-priority priority-${String(c.priority).toLowerCase()}`}>{c.priority}</span><span>Updated {formatDateTime(c.updated_at)}</span></div>
              <div className="ops-open-row"><span>Open case control</span><strong>›</strong></div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
