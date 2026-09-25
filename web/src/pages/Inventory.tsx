import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatMinorAmount } from '../lib/format';

type Vehicle = {
  id: string;
  vin: string | null;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  mileage: number | null;
  exterior_color: string | null;
  drivetrain: string | null;
  image_urls: string[];
  price_cents: number | null;
  last_seen_at: string;
};
type InventoryResponse = { inventory: Vehicle[]; total: number; updatedAt: string; pricingNotice: string };

const REFRESH_MS = 60_000;
const FILTERS = [
  { label: 'All trucks', q: '' },
  { label: 'F-150', q: 'F-150' },
  { label: 'F-250', q: 'F-250' },
  { label: 'Silverado 1500', q: 'Silverado 1500' },
  { label: 'Silverado 2500', q: 'Silverado 2500' },
  { label: 'Sierra', q: 'Sierra' }
];

export function Inventory() {
  const [filter, setFilter] = useState('');
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (filter) params.set('q', filter);
      setData(await api.get<InventoryResponse>(`/api/inventory?${params}`));
      setError(null);
    } catch {
      setError('Inventory is temporarily unavailable. Retrying shortly.');
    }
  }, [filter]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  return (
    <section className="space-y-5">
      <div>
        <span className="text-xs font-extrabold uppercase tracking-[0.18em] text-[var(--roviq-copper-soft)]">Live inventory</span>
        <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Low-mileage crew cab trucks</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--roviq-muted)] sm:text-base">
          Used F-150 SuperCrew, F-250, Silverado and Sierra 1500/2500 crew cabs under 50,000 miles. Prices update automatically.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by model">
        {FILTERS.map(f => (
          <button
            key={f.label}
            type="button"
            onClick={() => setFilter(f.q)}
            aria-pressed={filter === f.q}
            className={filter === f.q ? 'roviq-btn-primary text-sm' : 'roviq-btn-secondary text-sm'}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
      {data && (
        <p className="text-xs text-[var(--roviq-muted)]" aria-live="polite">
          {data.total} {data.total === 1 ? 'truck' : 'trucks'} · updated {new Date(data.updatedAt).toLocaleTimeString()} · {data.pricingNotice}
        </p>
      )}

      {data && data.inventory.length === 0 && (
        <p className="rounded-2xl border border-white/10 p-6 text-sm text-[var(--roviq-muted)]">No matching trucks right now. This page refreshes automatically.</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.inventory.map(v => (
          <article key={v.id} className="overflow-hidden rounded-2xl border border-white/10 bg-[var(--roviq-navy)]">
            {v.image_urls[0]
              ? <img src={v.image_urls[0]} alt={`${v.year ?? ''} ${v.make} ${v.model}`} loading="lazy" className="aspect-[4/3] w-full object-cover" />
              : <div className="aspect-[4/3] w-full bg-white/5" aria-hidden="true" />}
            <div className="space-y-1 p-4">
              <h2 className="font-semibold text-white">{[v.year, v.make, v.model].filter(Boolean).join(' ')}</h2>
              {v.trim && <p className="text-sm text-[var(--roviq-muted)]">{v.trim}</p>}
              <p className="text-sm text-[var(--roviq-muted)]">
                {v.mileage != null ? `${v.mileage.toLocaleString()} miles` : 'Mileage on request'}
                {v.drivetrain ? ` · ${v.drivetrain}` : ''}
                {v.exterior_color ? ` · ${v.exterior_color}` : ''}
              </p>
              <p className="pt-2 text-2xl font-bold text-white">
                {v.price_cents != null ? formatMinorAmount(v.price_cents, 'USD') : 'Call for price'}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
