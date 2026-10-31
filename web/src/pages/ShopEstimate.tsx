import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import roviqLogo from '../brand/roviq-lockup-dark.svg';

// A walk-in customer's private estimate page, opened from the link their shop sent. No account:
// the link itself opens this one repair order. They approve or decline each item, and once the
// work is done they can pay the balance by card.

type Line = { id: string; type: string; description: string; quantity: number; unitPrice: number; amount: number; approvalStatus: string };
type Estimate = {
  shop: { name: string; address?: string | null; city?: string | null; region?: string | null };
  customerName: string | null; vehicle: string | null; plate: string | null; repairOrderNumber: string; concern: string | null; status: string;
  lines: Line[]; totals: { estimate: number; approved: number; paid: number; balance: number; currency: string };
  canDecide: boolean; canPay: boolean;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
const STATUS: Record<string, string> = {
  awaiting_approval: 'Waiting for your approval', approved: 'Approved — work scheduled', in_progress: 'Work in progress', waiting_parts: 'Waiting for parts',
  waiting_customer: 'The shop needs to hear from you', quality_control: 'Final checks', completed: 'Ready for pickup', closed: 'Complete', cancelled: 'Cancelled'
};
const ERRORS: Record<string, string> = {
  link_not_found: 'This link has expired or been replaced. Ask the shop to send you a new one.',
  estimate_not_awaiting_approval: 'This estimate has already been answered.',
  service_credential_ineligible: 'The shop can’t accept approvals right now. Please call them.',
  online_payment_unavailable: 'Online payment isn’t available for this shop yet. You can pay at the counter.',
  nothing_to_pay: 'There’s nothing left to pay.'
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/public/shop-estimates/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'request_failed');
  return json as T;
}

export function ShopEstimate() {
  const { token = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [choice, setChoice] = useState<Record<string, 'approved' | 'declined'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const e = await call<Estimate>(encodeURIComponent(token));
      setEstimate(e);
      setChoice(Object.fromEntries(e.lines.map((l) => [l.id, l.approvalStatus === 'declined' ? 'declined' : 'approved'])));
    } catch (err) { setError(ERRORS[(err as Error).message] ?? 'We couldn’t open this estimate. Try again in a moment.'); }
  }, [token]);

  useEffect(() => {
    const sessionId = search.get('session_id');
    if (search.get('paid') === '1' && sessionId) {
      setNotice('Confirming your payment…');
      call<{ paid: boolean }>(`${encodeURIComponent(token)}/confirm`, { sessionId })
        .then((r) => setNotice(r.paid ? 'Payment received. Thank you!' : 'Your payment is processing. This page will update when it clears.'))
        .catch(() => setNotice('We couldn’t confirm your payment yet. If you were charged, the shop will see it shortly.'))
        .finally(() => { setSearch({}, { replace: true }); void load(); });
    } else void load();
  }, [token]);

  async function decide() {
    if (!estimate) return;
    setBusy(true); setError('');
    try {
      await call(`${encodeURIComponent(token)}/decision`, { decisions: estimate.lines.map((l) => ({ lineId: l.id, decision: choice[l.id] ?? 'approved' })) });
      setNotice('Thanks — the shop has your answer.');
      await load();
    } catch (err) { setError(ERRORS[(err as Error).message] ?? 'We couldn’t send your answer. Please try again.'); }
    finally { setBusy(false); }
  }

  async function pay() {
    setBusy(true); setError('');
    try { window.location.assign((await call<{ checkoutUrl: string }>(`${encodeURIComponent(token)}/checkout`, {})).checkoutUrl); }
    catch (err) { setError(ERRORS[(err as Error).message] ?? 'We couldn’t open the payment page. Please try again.'); setBusy(false); }
  }

  const selectedTotal = estimate ? estimate.lines.filter((l) => choice[l.id] === 'approved').reduce((s, l) => s + l.amount, 0) : 0;
  return (
    <div className="roviq-shell min-h-screen">
      <header className="roviq-header">
        <div className="roviq-header-inner mx-auto max-w-3xl px-4 sm:px-6">
          <span className="roviq-brand"><img className="roviq-logo" src={roviqLogo} alt="ROVIQ" /></span>
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--roviq-muted)]">Repair estimate</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
        {error && <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{notice}</p>}
        {!estimate && !error && <p className="roviq-muted">Loading your estimate…</p>}
        {estimate && (
          <>
            <section className="roviq-panel p-5">
              <p className="roviq-kicker">{estimate.shop.name}</p>
              <h1 className="mt-1 text-2xl font-bold">{estimate.customerName ? `Hi ${estimate.customerName}, here’s your estimate` : 'Your repair estimate'}</h1>
              <p className="roviq-muted mt-1 text-sm">{[estimate.vehicle, estimate.plate].filter(Boolean).join(' · ')}{estimate.vehicle ? ' · ' : ''}{estimate.repairOrderNumber}</p>
              {estimate.concern && <p className="mt-3 text-sm">You told us: “{estimate.concern}”</p>}
              <p className="mt-3 inline-block rounded-full border border-[var(--roviq-line)] px-3 py-1 text-xs font-semibold">{STATUS[estimate.status] ?? estimate.status}</p>
            </section>

            <section className="roviq-panel p-5">
              <h2 className="text-lg font-semibold">{estimate.canDecide ? 'Choose what to go ahead with' : 'Work items'}</h2>
              <ul className="mt-3 divide-y divide-[var(--roviq-line)]">
                {estimate.lines.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-medium">{l.description}</p>
                      <p className="roviq-muted text-xs">{l.type === 'labor' ? 'Labour' : l.type === 'part' ? 'Part' : l.type === 'fee' ? 'Fee' : 'Outside service'} · {l.quantity} × {money(l.unitPrice)}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold tabular-nums">{money(l.amount)}</span>
                      {estimate.canDecide ? (
                        <div className="flex overflow-hidden rounded-lg border border-[var(--roviq-line)]" role="radiogroup" aria-label={`Decision for ${l.description}`}>
                          {(['approved', 'declined'] as const).map((d) => (
                            <button key={d} type="button" role="radio" aria-checked={choice[l.id] === d} onClick={() => setChoice((c) => ({ ...c, [l.id]: d }))}
                              className={`min-h-11 px-3 text-sm font-semibold ${choice[l.id] === d ? (d === 'approved' ? 'bg-[var(--roviq-copper)] text-white' : 'bg-white/10') : ''}`}>
                              {d === 'approved' ? 'Yes' : 'Not now'}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="roviq-muted text-xs">{l.approvalStatus === 'approved' ? 'Approved' : l.approvalStatus === 'pending' ? 'Pending' : 'Not now'}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <dl className="mt-4 grid gap-1 border-t border-[var(--roviq-line)] pt-4 text-sm">
                {estimate.canDecide
                  ? <div className="flex justify-between font-semibold"><dt>Total for the items you chose</dt><dd className="tabular-nums">{money(selectedTotal)}</dd></div>
                  : <>
                      <div className="flex justify-between"><dt>Approved work</dt><dd className="tabular-nums">{money(estimate.totals.approved)}</dd></div>
                      <div className="flex justify-between"><dt>Paid</dt><dd className="tabular-nums">{money(estimate.totals.paid)}</dd></div>
                      <div className="flex justify-between font-semibold"><dt>Balance</dt><dd className="tabular-nums">{money(estimate.totals.balance)}</dd></div>
                    </>}
              </dl>
              {estimate.canDecide && <button type="button" className="roviq-btn-primary mt-4 w-full" disabled={busy} onClick={() => void decide()}>{busy ? 'Sending…' : 'Send my answer to the shop'}</button>}
              {estimate.canPay && <button type="button" className="roviq-btn-primary mt-4 w-full" disabled={busy} onClick={() => void pay()}>{busy ? 'Opening payment…' : `Pay ${money(estimate.totals.balance)} by card`}</button>}
            </section>
            <p className="roviq-muted text-center text-xs">{[estimate.shop.address, estimate.shop.city, estimate.shop.region].filter(Boolean).join(', ')}</p>
          </>
        )}
      </main>
    </div>
  );
}
