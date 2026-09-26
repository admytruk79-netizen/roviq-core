import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';

type Vehicle = {
  id: string;
  condition: 'new' | 'used' | null;
  vin: string | null;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  mileage: number | null;
  exterior_color: string | null;
  drivetrain: string | null;
  fuel_type: string | null;
  body_style: string | null;
  image_urls: string[];
  price_cents: number | null;
  last_seen_at: string;
};
type InventoryResponse = { inventory: Vehicle[]; total: number; updatedAt: string; pricingNotice: string };

const REFRESH_MS = 60_000;
const CONTACT_EMAIL = import.meta.env.VITE_INVENTORY_CONTACT_EMAIL as string | undefined;
const CONTACT_PHONE = import.meta.env.VITE_INVENTORY_CONTACT_PHONE as string | undefined;

const CONDITIONS = [
  { value: '', label: 'New & used' },
  { value: 'new', label: 'New' },
  { value: 'used', label: 'Used' }
];
const MODELS = [
  { label: 'All trucks', q: '' },
  { label: 'F-150', q: 'F-150' },
  { label: 'F-250', q: 'F-250' },
  { label: 'Silverado 1500', q: 'Silverado 1500' },
  { label: 'Silverado 2500', q: 'Silverado 2500' },
  { label: 'Sierra 1500', q: 'Sierra 1500' },
  { label: 'Sierra 2500', q: 'Sierra 2500' }
];
const SORTS = [
  { value: 'recommended', label: 'Newest, lowest miles' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'miles_asc', label: 'Mileage: lowest first' },
  { value: 'year_desc', label: 'Year: newest first' }
];
const PRICE_CAPS = [
  { value: '', label: 'Any price' },
  { value: '3000000', label: 'Under $30,000' },
  { value: '4000000', label: 'Under $40,000' },
  { value: '5000000', label: 'Under $50,000' },
  { value: '6000000', label: 'Under $60,000' },
  { value: '7500000', label: 'Under $75,000' }
];
const MILE_CAPS = [
  { value: '', label: 'Up to 50k mi' },
  { value: '10000', label: 'Up to 10k mi' },
  { value: '25000', label: 'Up to 25k mi' },
  { value: '35000', label: 'Up to 35k mi' }
];

const title = (v: Vehicle) => [v.year, v.make, v.model].filter(Boolean).join(' ');
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const price = (v: Vehicle) => (v.price_cents != null ? dollars.format(Math.round(v.price_cents / 100)) : 'Call for price');
const miles = (v: Vehicle) => (v.condition === 'new' && (v.mileage ?? 0) < 500 ? 'New' : v.mileage != null ? `${v.mileage.toLocaleString()} mi` : 'Mileage on request');

function cabLabel(v: Vehicle) {
  const text = `${v.model} ${v.trim ?? ''} ${v.body_style ?? ''}`;
  if (/super\s*crew/i.test(text)) return 'SuperCrew';
  if (/crew/i.test(text)) return 'Crew Cab';
  return null;
}

function driveLabel(v: Vehicle) {
  const d = `${v.drivetrain ?? ''} ${v.trim ?? ''}`;
  if (/4x4|4wd|four.?wheel/i.test(d)) return '4x4';
  if (/awd|all.?wheel/i.test(d)) return 'AWD';
  if (/2wd|rwd|4x2|rear.?wheel/i.test(d)) return '2WD';
  return v.drivetrain;
}

function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

function Photo({ src, alt, className }: { src?: string; alt: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`${className} flex items-center justify-center bg-gradient-to-br from-white/[0.06] to-white/[0.01] text-[var(--roviq-slate)]`} role="img" aria-label={`${alt} — photo coming soon`}>
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 16V9a1 1 0 0 1 1-1h9l3 4h3a2 2 0 0 1 2 2v2" /><circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" /><path d="M9 17h6" /></svg>
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={`${className} object-cover`} />;
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-[var(--roviq-line)] bg-white/[0.04] px-2.5 py-1 text-xs font-semibold text-[var(--roviq-porcelain)]">{children}</span>;
}

function TruckCard({ v, changed, onOpen }: { v: Vehicle; changed: boolean; onOpen: () => void }) {
  const cab = cabLabel(v);
  const drive = driveLabel(v);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--roviq-line)] bg-[var(--roviq-panel)] text-left shadow-[0_18px_50px_rgba(0,0,0,.18)] transition hover:-translate-y-0.5 hover:border-[var(--roviq-copper)]/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--roviq-copper-soft)]"
    >
      <div className="relative">
        <Photo src={v.image_urls[0]} alt={title(v)} className="aspect-[16/10] w-full transition duration-300 group-hover:scale-[1.02]" />
        {v.image_urls.length > 1 && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/65 px-2 py-0.5 text-xs font-semibold text-white">{v.image_urls.length} photos</span>
        )}
        {v.condition === 'new' && (
          <span className="absolute right-2 top-2 rounded-md bg-[var(--roviq-success)] px-2 py-0.5 text-xs font-extrabold uppercase tracking-wide text-white">New</span>
        )}
        {changed && (
          <span className="absolute left-2 top-2 rounded-md bg-[var(--roviq-copper)] px-2 py-0.5 text-xs font-bold text-white">Price updated</span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h2 className="text-lg font-bold leading-tight text-white">{title(v)}</h2>
          {v.trim && <p className="mt-0.5 line-clamp-1 text-sm text-[var(--roviq-muted)]">{v.trim}</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {miles(v) !== 'New' && <Pill>{miles(v)}</Pill>}
          {cab && <Pill>{cab}</Pill>}
          {drive && <Pill>{drive}</Pill>}
          {v.exterior_color && <Pill>{v.exterior_color}</Pill>}
        </div>
        <div className="mt-auto flex items-end justify-between border-t border-[var(--roviq-line)] pt-3">
          <div>
            <span className="block text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--roviq-muted)]">Price</span>
            <span className="text-2xl font-extrabold text-white">{price(v)}</span>
          </div>
          <span className="text-sm font-bold text-[var(--roviq-copper-soft)]">View details →</span>
        </div>
      </div>
    </button>
  );
}

function TruckDialog({ v, onClose }: { v: Vehicle | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [photo, setPhoto] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (v && !dialog.open) dialog.showModal();
    if (!v && dialog.open) dialog.close();
  }, [v]);

  if (!v) return <dialog ref={ref} onClose={onClose} />;
  const photos = v.image_urls.length ? v.image_urls : [undefined];
  const current = Math.min(photo, photos.length - 1);
  const step = (d: number) => setPhoto((current + d + photos.length) % photos.length);
  const specs: [string, string | null][] = [
    ['Mileage', miles(v)], ['Cab', cabLabel(v)], ['Drivetrain', driveLabel(v)], ['Color', v.exterior_color],
    ['Fuel', v.fuel_type], ['Body', v.body_style], ['VIN', v.vin]
  ];
  const subject = encodeURIComponent(`${title(v)}${v.vin ? ` (VIN ${v.vin})` : ''}`);

  return (
    <dialog
      ref={ref}
      onClose={() => { setPhoto(0); setCopied(false); onClose(); }}
      onClick={e => { if (e.target === ref.current) ref.current?.close(); }}
      onKeyDown={e => { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); }}
      aria-label={title(v)}
      className="m-auto w-[min(960px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-y-auto rounded-2xl border border-[var(--roviq-line)] bg-[var(--roviq-navy)] p-0 text-[var(--roviq-porcelain)] backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="grid md:grid-cols-[1.4fr_1fr]">
        <div className="relative bg-[var(--roviq-navy-deep)]">
          <Photo key={photos[current]} src={photos[current]} alt={`${title(v)} photo ${current + 1}`} className="aspect-[4/3] w-full" />
          {photos.length > 1 && (
            <>
              <button type="button" onClick={() => step(-1)} aria-label="Previous photo" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 px-3 py-2 text-lg text-white hover:bg-black/80">‹</button>
              <button type="button" onClick={() => step(1)} aria-label="Next photo" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 px-3 py-2 text-lg text-white hover:bg-black/80">›</button>
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-black/65 px-2 py-0.5 text-xs text-white">{current + 1} / {photos.length}</span>
            </>
          )}
          {photos.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto bg-[var(--roviq-navy-deep)] p-2">
              {photos.slice(0, 20).map((src, i) => (
                <button key={`${src}-${i}`} type="button" onClick={() => setPhoto(i)} aria-label={`Show photo ${i + 1}`}
                  className={`h-14 w-20 flex-none overflow-hidden rounded-md border-2 ${i === current ? 'border-[var(--roviq-copper)]' : 'border-transparent opacity-70 hover:opacity-100'}`}>
                  <Photo src={src} alt="" className="h-full w-full" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-bold leading-tight text-white">{title(v)}</h2>
              {v.trim && <p className="mt-1 text-sm text-[var(--roviq-muted)]">{v.trim}</p>}
            </div>
            <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-lg px-2 py-1 text-2xl leading-none text-[var(--roviq-muted)] hover:bg-white/10 hover:text-white">×</button>
          </div>
          <div className="rounded-xl border border-[var(--roviq-line)] bg-white/[0.03] p-4">
            <span className="block text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--roviq-muted)]">Price</span>
            <span className="text-3xl font-extrabold text-white">{price(v)}</span>
            <p className="mt-1 text-xs text-[var(--roviq-muted)]">Plus tax, title and registration.</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {specs.filter(([, value]) => value).map(([label, value]) => (
              <div key={label} className={label === 'VIN' ? 'col-span-2' : ''}>
                <dt className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[var(--roviq-muted)]">{label}</dt>
                <dd className={`mt-0.5 font-semibold text-white ${label === 'VIN' ? 'break-all font-mono text-xs' : ''}`}>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-auto flex flex-col gap-2">
            {CONTACT_PHONE && <a href={`tel:${CONTACT_PHONE}`} className="roviq-btn-primary w-full text-sm">Call about this truck</a>}
            {CONTACT_EMAIL && <a href={`mailto:${CONTACT_EMAIL}?subject=${subject}`} className={`${CONTACT_PHONE ? 'roviq-btn-secondary' : 'roviq-btn-primary'} w-full text-sm`}>Email about this truck</a>}
            {v.vin && (
              <button type="button" className="roviq-btn-secondary w-full text-sm"
                onClick={() => navigator.clipboard?.writeText(v.vin!).then(() => setCopied(true)).catch(() => {})}>
                {copied ? 'VIN copied' : 'Copy VIN'}
              </button>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-[var(--roviq-line)] bg-[var(--roviq-panel)]">
          <div className="aspect-[16/10] animate-pulse bg-white/[0.06]" />
          <div className="space-y-3 p-4">
            <div className="h-5 w-3/4 animate-pulse rounded bg-white/[0.08]" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-white/[0.06]" />
            <div className="h-8 w-1/3 animate-pulse rounded bg-white/[0.08]" />
          </div>
        </div>
      ))}
    </div>
  );
}

const selectClass = 'roviq-input min-h-[44px] rounded-xl border border-[var(--roviq-line)] bg-[var(--roviq-navy)] px-3 text-sm text-white';

export function Inventory() {
  const [params, setParams] = useSearchParams();
  const model = params.get('model') ?? '';
  const sort = params.get('sort') ?? 'recommended';
  const maxPrice = params.get('maxPrice') ?? '';
  const condition = params.get('condition') ?? '';
  const maxMiles = condition === 'new' ? '' : params.get('maxMiles') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(search);
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const prices = useRef(new Map<string, number | null>());

  const update = useCallback((key: string, value: string) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    const t = setTimeout(() => { setQuery(search.trim()); update('q', search.trim()); }, 300);
    return () => clearTimeout(t);
  }, [search, update]);

  const apiPath = useMemo(() => {
    const p = new URLSearchParams({ limit: '100', sort });
    // Dealer model names vary ("Silverado 2500HD", "Super Duty F-250 SRW"), so match inside them.
    if (model) p.set('model', `%${model}%`);
    if (query) p.set('q', query);
    if (maxPrice) p.set('maxPriceCents', maxPrice);
    if (condition) p.set('condition', condition);
    if (maxMiles) p.set('maxMileage', maxMiles);
    return `/api/inventory?${p}`;
  }, [model, query, sort, maxPrice, maxMiles, condition]);

  const load = useCallback(async () => {
    try {
      const next = await api.get<InventoryResponse>(apiPath);
      const moved = new Set<string>();
      for (const v of next.inventory) {
        const before = prices.current.get(v.id);
        if (before !== undefined && before !== v.price_cents) moved.add(v.id);
        prices.current.set(v.id, v.price_cents);
      }
      if (moved.size) setChanged(prev => new Set([...prev, ...moved]));
      setData(next);
      setError(null);
    } catch {
      setError('Inventory is temporarily unavailable. Retrying automatically.');
    } finally {
      setLoading(false);
    }
  }, [apiPath]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const filtered = Boolean(model || query || maxPrice || maxMiles || condition);
  const clearAll = () => { setSearch(''); setQuery(''); setParams(new URLSearchParams(sort !== 'recommended' ? { sort } : {}), { replace: true }); };

  return (
    <section className="space-y-6">
      <div className="roviq-customer-hero">
        <div>
          <span className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.18em] text-[var(--roviq-copper-soft)]">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--roviq-success)] opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--roviq-success)]" /></span>
            Live inventory
          </span>
          <h1 className="text-white">Crew cab trucks, new and used</h1>
          <p className="text-[var(--roviq-muted)]">New Ford F-150 SuperCrew and F-250 crew cabs in every trim, plus used F-150, F-250, Chevy Silverado and GMC Sierra 1500/2500 crew cabs with 50,000 miles or less.</p>
        </div>
      </div>

      <div className="sticky top-0 z-20 -mx-4 space-y-3 border-b border-[var(--roviq-line)] bg-[var(--roviq-bg)]/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative flex-1">
            <span className="sr-only">Search trucks</span>
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search trim, year or color — e.g. Lariat, 2022, AT4"
              className={`${selectClass} w-full`}
            />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <label className="col-span-2"><span className="sr-only">Sort</span>
              <select value={sort} onChange={e => update('sort', e.target.value === 'recommended' ? '' : e.target.value)} className={`${selectClass} w-full`}>
                {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label><span className="sr-only">Maximum price</span>
              <select value={maxPrice} onChange={e => update('maxPrice', e.target.value)} className={`${selectClass} w-full`}>
                {PRICE_CAPS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label><span className="sr-only">Maximum mileage</span>
              <select value={maxMiles} disabled={condition === 'new'} onChange={e => update('maxMiles', e.target.value)} className={`${selectClass} w-full`}>
                {MILE_CAPS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="inline-flex rounded-xl border border-[var(--roviq-line)] p-1" role="group" aria-label="New or used">
          {CONDITIONS.map(c => (
            <button
              key={c.label}
              type="button"
              onClick={() => update('condition', c.value)}
              aria-pressed={condition === c.value}
              className={`rounded-lg px-4 py-1.5 text-sm font-bold transition ${condition === c.value ? 'bg-[var(--roviq-copper)] text-white' : 'text-[var(--roviq-porcelain)] hover:bg-white/10'}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter by model">
          {MODELS.map(m => (
            <button
              key={m.label}
              type="button"
              onClick={() => update('model', m.q)}
              aria-pressed={model === m.q}
              className={`flex-none rounded-full border px-4 py-2 text-sm font-bold transition ${model === m.q ? 'border-[var(--roviq-copper)] bg-[var(--roviq-copper)] text-white' : 'border-[var(--roviq-line)] text-[var(--roviq-porcelain)] hover:border-[var(--roviq-copper-soft)]'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
        <span className="font-semibold text-white">
          {data ? `${data.total} ${data.total === 1 ? 'truck' : 'trucks'} available` : 'Loading trucks…'}
        </span>
        {data && <span className="text-xs text-[var(--roviq-muted)]">Updated {relativeTime(data.updatedAt, now)} · refreshes automatically</span>}
      </div>

      {error && <p role="alert" className="roviq-error text-sm">{error}</p>}

      {loading && !data ? <SkeletonGrid /> : data && data.inventory.length === 0 ? (
        <div className="roviq-panel roviq-empty-state rounded-2xl border border-[var(--roviq-line)]">
          <h2 className="text-lg font-bold text-white">No trucks match right now</h2>
          <p className="text-sm text-[var(--roviq-muted)]">New trucks are checked every few minutes. {filtered ? 'Try widening your filters.' : 'Check back soon.'}</p>
          {filtered && <button type="button" onClick={clearAll} className="roviq-btn-primary text-sm">Clear filters</button>}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.inventory.map(v => <TruckCard key={v.id} v={v} changed={changed.has(v.id)} onOpen={() => setSelected(v)} />)}
        </div>
      )}

      {data && <p className="text-xs text-[var(--roviq-muted)]">{data.pricingNotice}</p>}

      <TruckDialog v={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
