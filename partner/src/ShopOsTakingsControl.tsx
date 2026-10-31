import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// The shop's own books: jobs finished, what they earned and cost, money collected by method, and
// walk-in customers who still owe. Network jobs are paid through ROVIQ, so they never show as owing.

type Day = { day: string; jobs: number; revenue: number; directCost: number; laborCost: number; contribution: number; collected: Record<string, number> };
type Takings = {
  days: Day[]; totals: { jobs: number; revenue: number; directCost: number; laborCost: number; contribution: number; collected: number };
  outstanding: { repairOrderId: string; number: string; customer: string | null; vehicle: string | null; completedAt: string; balance: number }[];
  unsettledJobs: number;
};

const money = (v: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(v);
const RANGES = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days' } as const;
const METHOD: Record<string, string> = { card_online: 'Card online', card_terminal: 'Card terminal', cash: 'Cash', other: 'Other' };

function range(kind: keyof typeof RANGES) {
  const to = new Date(); to.setHours(24, 0, 0, 0);
  const from = new Date(to); from.setDate(from.getDate() - (kind === 'today' ? 1 : kind === 'week' ? 7 : 30));
  return { from: from.toISOString(), to: to.toISOString() };
}

export function ShopOsTakingsControl() {
  const [kind, setKind] = useState<keyof typeof RANGES>('today');
  const [data, setData] = useState<Takings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const { from, to } = range(kind);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { setData(await api.get<Takings>(`/api/shop-os/takings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timeZone=${encodeURIComponent(tz)}`)); }
    catch { setMessage('Could not load takings.'); }
  }, [kind]);
  useEffect(() => { void load(); }, [load]);

  async function settle() {
    setBusy(true); setMessage('');
    try { const r = await api.post<{ settled: number; skipped: unknown[] }>('/api/shop-os/takings/settle', {}); setMessage(`Settled ${r.settled} job${r.settled === 1 ? '' : 's'}${r.skipped.length ? `; ${r.skipped.length} still have open work or parts` : ''}.`); await load(); }
    catch { setMessage('Could not settle jobs.'); }
    finally { setBusy(false); }
  }

  const t = data?.totals;
  return (
    <section className="mt-8" aria-labelledby="takings-heading">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div><p className="kicker">Your books</p><h2 id="takings-heading" className="mt-1 text-2xl font-bold">Takings</h2><p className="muted mt-1 max-w-2xl text-sm">Finished jobs, what they earned and cost, and the money you actually collected. Jobs settle automatically when you complete them.</p></div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Period">{(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((k) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'primary' : 'secondary'} onClick={() => setKind(k)}>{RANGES[k]}</button>)}</div>
      </div>
      {t && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="stat"><p className="muted text-xs uppercase tracking-[.14em]">Jobs finished</p><p className="mt-2 text-3xl font-black">{t.jobs}</p></div>
          <div className="stat"><p className="muted text-xs uppercase tracking-[.14em]">Earned</p><p className="mt-2 text-2xl font-black">{money(t.revenue)}</p></div>
          <div className="stat"><p className="muted text-xs uppercase tracking-[.14em]">Parts & labour cost</p><p className="mt-2 text-2xl font-black">{money(t.directCost + t.laborCost)}</p></div>
          <div className="stat"><p className="muted text-xs uppercase tracking-[.14em]">Margin</p><p className="mt-2 text-2xl font-black text-[var(--green)]">{money(t.contribution)}</p></div>
          <div className="stat"><p className="muted text-xs uppercase tracking-[.14em]">Collected</p><p className="mt-2 text-2xl font-black">{money(t.collected)}</p></div>
        </div>
      )}
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
        <div className="panel p-5">
          <h3 className="font-bold">By day</h3>
          {!data?.days.length ? <p className="muted mt-2 text-sm">No finished jobs or payments in this period.</p> : (
            <div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="muted text-left text-xs uppercase tracking-[.1em]"><th className="py-2 pr-3">Day</th><th className="pr-3">Jobs</th><th className="pr-3">Earned</th><th className="pr-3">Cost</th><th className="pr-3">Margin</th><th>Collected</th></tr></thead>
              <tbody>{data.days.map((d) => <tr key={d.day} className="border-t border-white/10 tabular-nums"><td className="py-2 pr-3">{new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td className="pr-3">{d.jobs}</td><td className="pr-3">{money(d.revenue)}</td><td className="pr-3">{money(d.directCost + d.laborCost)}</td><td className="pr-3">{money(d.contribution)}</td><td>{Object.entries(d.collected).map(([m, v]) => `${METHOD[m] ?? m} ${money(v)}`).join(' · ') || '—'}</td></tr>)}</tbody></table></div>
          )}
          {data && data.unsettledJobs > 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/30 p-3 text-sm"><span>{data.unsettledJobs} finished job{data.unsettledJobs === 1 ? ' isn’t' : 's aren’t'} in your books yet.</span><button type="button" className="secondary" disabled={busy} onClick={() => void settle()}>{busy ? 'Settling…' : 'Settle now'}</button></div>}
          {message && <p className="muted mt-3 text-sm" role="status">{message}</p>}
        </div>
        <div className="panel p-5">
          <h3 className="font-bold">Customers who owe</h3>
          {!data?.outstanding.length ? <p className="muted mt-2 text-sm">Nobody owes you for finished work.</p> : (
            <ul className="mt-3 space-y-2 text-sm">{data.outstanding.map((o) => <li key={o.repairOrderId} className="flex justify-between gap-3 rounded-xl border border-white/10 p-3"><span><b>{o.customer ?? 'Walk-in customer'}</b><span className="muted block text-xs">{[o.vehicle, o.number].filter(Boolean).join(' · ')}</span></span><span className="font-bold tabular-nums">{money(o.balance)}</span></li>)}</ul>
          )}
        </div>
      </div>
    </section>
  );
}
