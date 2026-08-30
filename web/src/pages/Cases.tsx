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

  const openCount = cases?.filter(c => !['completed','closed','cancelled'].includes(String(c.state).toLowerCase())).length ?? 0;

  return (
    <div className="space-y-5">
      <section className="roviq-customer-hero">
        <div>
          <p className="roviq-kicker">Your vehicle care</p>
          <h1>My cases</h1>
          <p className="roviq-muted">Follow active service, transportation and repair progress from one place.</p>
        </div>
        <Link to="/cases/new" className="roviq-btn-primary roviq-start-service">Start service</Link>
      </section>

      <section className="roviq-summary-strip" aria-label="Case summary">
        <div><span>Active</span><strong>{openCount}</strong></div>
        <div><span>Total</span><strong>{cases?.length ?? '—'}</strong></div>
        <div><span>Updates</span><strong>{openCount ? 'Live' : '—'}</strong></div>
      </section>

      {error && <div className="roviq-error">{error}</div>}
      {cases === null && !error && <div className="roviq-panel p-5 text-sm roviq-muted">Loading your cases…</div>}

      {cases !== null && cases.length === 0 && (
        <section className="roviq-panel roviq-empty-state">
          <p className="roviq-kicker">No cases yet</p>
          <h2>Your service history will appear here.</h2>
          <p className="roviq-muted">Start a case when you need diagnostics, repair coordination, towing or related service.</p>
          <Link to="/cases/new" className="roviq-btn-primary">Report an issue</Link>
        </section>
      )}

      {cases !== null && cases.length > 0 && (
        <section className="roviq-case-list">
          {cases.map((c) => (
            <Link key={c.id} to={`/cases/${c.id}`} className="roviq-case-card">
              <div className="roviq-case-copy">
                <p className="roviq-kicker">{String(c.case_type).replaceAll('_',' ')} case</p>
                <h2>Case {c.id.slice(0,8)}</h2>
                <p className="roviq-muted">Opened {formatDateTime(c.created_at)}</p>
              </div>
              <div className="roviq-case-status"><StatusBadge state={c.state} /><span aria-hidden="true">›</span></div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
