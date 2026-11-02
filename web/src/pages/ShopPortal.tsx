import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

// A shop's own customer portal (Shop OS). The shop sends its customer one private link; it shows
// the job in the shop right now with live progress and the shop's messages, the inspection report,
// approvals and payment, upcoming visits, work recommended for later and service history. Branded
// as the shop: ROVIQ only appears as "powered by".

type Line = { id: string; type: string; description: string; quantity: number; unitPrice: number; amount: number; approvalStatus: string };
type Finding = { section: string; item: string; condition: 'good' | 'attention' | 'urgent'; measurement: string | null; note: string | null; photos: { url: string; caption: string | null }[] };
type Job = {
  id: string; number: string; vehicle: string | null; concern: string | null; status: string; statusText: string; stage: string; active: boolean;
  openedAt: string; completedAt: string | null; odometer: number | null; lines: Line[];
  totals: { estimate: number; approved: number; paid: number; balance: number };
  updates: { message: string; at: string }[];
  inspection: { summary: string | null; submittedAt: string; findings: Finding[] } | null;
  canDecide: boolean; canPay: boolean;
};
type Portal = {
  shop: { name: string; address?: string | null; city?: string | null; region?: string | null };
  customer: { name: string | null };
  vehicles: { id: string; name: string; plate: string | null }[];
  jobs: Job[];
  upcoming: { startsAt: string; endsAt: string; summary: string | null; vehicle: string | null; confirmed: boolean }[];
  recommended: { id: string; description: string; severity: string; estimate: number; suggestedBy: string | null; vehicle: string | null }[];
  progressSteps: string[];
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
const day = (v: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(v));
const time = (v: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(v));
const STEP_LABEL: Record<string, string> = { checked_in: 'Checked in', inspection: 'Inspection', approval: 'Your approval', repair: 'Repair', final_check: 'Final check', ready: 'Ready' };
const CONDITION = {
  urgent: { label: 'Needs attention now', dot: 'bg-red-400', text: 'text-red-200' },
  attention: { label: 'Keep an eye on it', dot: 'bg-amber-300', text: 'text-amber-100' },
  good: { label: 'Good', dot: 'bg-emerald-400', text: 'text-emerald-100' }
} as const;
const ERRORS: Record<string, string> = {
  link_not_found: 'This link has expired or been replaced. Ask the shop to send you a new one.',
  estimate_not_awaiting_approval: 'This estimate has already been answered.',
  service_credential_ineligible: 'The shop can’t accept approvals right now. Please call them.',
  online_payment_unavailable: 'Online payment isn’t available for this shop yet. You can pay at the counter.',
  nothing_to_pay: 'There’s nothing left to pay.'
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/public/shop-portal/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'request_failed');
  return json as T;
}

function Progress({ steps, stage }: { steps: string[]; stage: string }) {
  const at = stage === 'done' ? steps.length - 1 : steps.indexOf(stage);
  return (
    <div className="mt-4">
      <ol className="grid grid-cols-6 gap-1" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s} className="min-w-0" aria-current={i === at ? 'step' : undefined}>
            <div className={`h-1.5 rounded-full ${i <= at ? 'bg-[var(--roviq-copper)]' : 'bg-white/15'}`} />
            <p className={`mt-1.5 hidden truncate text-[11px] sm:block ${i === at ? 'font-semibold text-white' : 'text-[var(--roviq-muted)]'}`}>{STEP_LABEL[s] ?? s}</p>
            <span className="sr-only sm:hidden">{STEP_LABEL[s] ?? s}</span>
          </li>
        ))}
      </ol>
      {at >= 0 && <p className="mt-1.5 text-xs sm:hidden" aria-hidden="true"><span className="text-[var(--roviq-muted)]">Step {at + 1} of {steps.length} · </span><span className="font-semibold">{STEP_LABEL[steps[at]] ?? steps[at]}</span></p>}
    </div>
  );
}

function JobCard({ job, steps, token, onChanged, setError }: { job: Job; steps: string[]; token: string; onChanged: (notice: string) => Promise<void>; setError: (e: string) => void }) {
  const [choice, setChoice] = useState<Record<string, 'approved' | 'declined'>>(() => Object.fromEntries(job.lines.map((l) => [l.id, 'approved'])));
  const [busy, setBusy] = useState(false);
  const selected = job.lines.filter((l) => choice[l.id] === 'approved').reduce((s, l) => s + l.amount, 0);
  const path = `${encodeURIComponent(token)}/jobs/${job.id}`;

  async function decide() {
    setBusy(true); setError('');
    try { await call(`${path}/decision`, { decisions: job.lines.map((l) => ({ lineId: l.id, decision: choice[l.id] ?? 'approved' })) }); await onChanged('Thanks — the shop has your answer.'); }
    catch (err) { setError(ERRORS[(err as Error).message] ?? 'We couldn’t send your answer. Please try again.'); }
    finally { setBusy(false); }
  }
  async function pay() {
    setBusy(true); setError('');
    try { window.location.assign((await call<{ checkoutUrl: string }>(`${path}/checkout`, {})).checkoutUrl); }
    catch (err) { setError(ERRORS[(err as Error).message] ?? 'We couldn’t open the payment page.'); setBusy(false); }
  }

  return (
    <article className="roviq-panel p-5" aria-label={`Job ${job.number}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><p className="roviq-kicker">{job.vehicle ?? 'Your vehicle'}</p><h2 className="mt-1 text-xl font-bold">{job.statusText}</h2>{job.concern && <p className="roviq-muted mt-1 text-sm">You told us: “{job.concern}”</p>}</div>
        <span className="roviq-muted text-xs">{job.number} · {day(job.openedAt)}</span>
      </div>
      <Progress steps={steps} stage={job.stage} />

      {job.updates.length > 0 && (
        <section className="mt-5" aria-label="Updates from the shop">
          <h3 className="text-sm font-semibold">Updates from the shop</h3>
          <ul className="mt-2 space-y-2">{job.updates.slice(0, 5).map((u, i) => <li key={i} className={`rounded-xl border border-[var(--roviq-line)] px-3 py-2 text-sm ${i === 0 ? 'bg-white/5' : ''}`}><p>{u.message}</p><p className="roviq-muted mt-0.5 text-[11px]">{time(u.at)}</p></li>)}</ul>
        </section>
      )}

      {job.inspection && job.inspection.findings.length > 0 && (
        <section className="mt-5" aria-label="Inspection report">
          <h3 className="text-sm font-semibold">Inspection report</h3>
          {job.inspection.summary && <p className="roviq-muted mt-1 text-sm">{job.inspection.summary}</p>}
          <ul className="mt-2 space-y-2">
            {job.inspection.findings.map((f, i) => {
              const c = CONDITION[f.condition] ?? CONDITION.good;
              return (
                <li key={i} className="rounded-xl border border-[var(--roviq-line)] p-3">
                  <div className="flex items-start justify-between gap-3"><p className="font-medium">{f.item}<span className="roviq-muted block text-xs">{f.section}{f.measurement ? ` · ${f.measurement}` : ''}</span></p><span className={`flex shrink-0 items-center gap-1.5 text-xs ${c.text}`}><span className={`h-2.5 w-2.5 rounded-full ${c.dot}`} />{c.label}</span></div>
                  {f.note && <p className="mt-1 text-sm">{f.note}</p>}
                  {f.photos.length > 0 && <div className="mt-2 flex gap-2 overflow-x-auto">{f.photos.map((p, j) => <a key={j} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.caption ?? f.item} className="h-24 w-32 rounded-lg object-cover" loading="lazy" /></a>)}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {job.lines.length > 0 && (
        <section className="mt-5" aria-label="Estimate">
          <h3 className="text-sm font-semibold">{job.canDecide ? 'Choose what to go ahead with' : 'Work'}</h3>
          <ul className="mt-2 divide-y divide-[var(--roviq-line)]">
            {job.lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0"><p className="font-medium">{l.description}</p><p className="roviq-muted text-xs">{l.type === 'labor' ? 'Labour' : l.type === 'part' ? 'Part' : l.type === 'fee' ? 'Fee' : 'Outside service'}</p></div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums">{money(l.amount)}</span>
                  {job.canDecide ? (
                    <div className="flex overflow-hidden rounded-lg border border-[var(--roviq-line)]" role="radiogroup" aria-label={`Decision for ${l.description}`}>
                      {(['approved', 'declined'] as const).map((d) => <button key={d} type="button" role="radio" aria-checked={choice[l.id] === d} onClick={() => setChoice((c) => ({ ...c, [l.id]: d }))} className={`min-h-11 px-3 text-sm font-semibold ${choice[l.id] === d ? (d === 'approved' ? 'bg-[var(--roviq-copper)] text-white' : 'bg-white/10') : ''}`}>{d === 'approved' ? 'Yes' : 'Not now'}</button>)}
                    </div>
                  ) : <span className="roviq-muted text-xs">{l.approvalStatus === 'approved' ? 'Approved' : l.approvalStatus === 'pending' ? 'Pending' : 'Not now'}</span>}
                </div>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid gap-1 border-t border-[var(--roviq-line)] pt-3 text-sm">
            {job.canDecide
              ? <div className="flex justify-between font-semibold"><dt>Total for the items you chose</dt><dd className="tabular-nums">{money(selected)}</dd></div>
              : <><div className="flex justify-between"><dt>Approved work</dt><dd className="tabular-nums">{money(job.totals.approved)}</dd></div><div className="flex justify-between"><dt>Paid</dt><dd className="tabular-nums">{money(job.totals.paid)}</dd></div><div className="flex justify-between font-semibold"><dt>Balance</dt><dd className="tabular-nums">{money(job.totals.balance)}</dd></div></>}
          </dl>
          {job.canDecide && <button type="button" className="roviq-btn-primary mt-4 w-full" disabled={busy} onClick={() => void decide()}>{busy ? 'Sending…' : 'Send my answer to the shop'}</button>}
          {job.canPay && <button type="button" className="roviq-btn-primary mt-4 w-full" disabled={busy} onClick={() => void pay()}>{busy ? 'Opening payment…' : `Pay ${money(job.totals.balance)} by card`}</button>}
        </section>
      )}
    </article>
  );
}

export function ShopPortal() {
  const { token = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const [portal, setPortal] = useState<Portal | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try { setPortal(await call<Portal>(encodeURIComponent(token))); }
    catch (err) { setError(ERRORS[(err as Error).message] ?? 'We couldn’t open your page. Try again in a moment.'); }
  }, [token]);

  useEffect(() => {
    const sessionId = search.get('session_id'); const job = search.get('job');
    if (search.get('paid') === '1' && sessionId && job) {
      setNotice('Confirming your payment…');
      call<{ paid: boolean }>(`${encodeURIComponent(token)}/jobs/${job}/confirm`, { sessionId })
        .then((r) => setNotice(r.paid ? 'Payment received. Thank you!' : 'Your payment is processing. This page will update when it clears.'))
        .catch(() => setNotice('We couldn’t confirm your payment yet. If you were charged, the shop will see it shortly.'))
        .finally(() => { setSearch({}, { replace: true }); void load(); });
    } else void load();
    // Keep the page current while the car is in the shop.
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [token]);

  const refresh = async (message: string) => { setNotice(message); await load(); };
  const active = portal?.jobs.filter((j) => j.active) ?? [];
  const history = portal?.jobs.filter((j) => !j.active) ?? [];
  return (
    <div className="roviq-shell min-h-screen">
      <header className="roviq-header">
        <div className="roviq-header-inner mx-auto max-w-3xl px-4 sm:px-6">
          <span className="text-lg font-bold tracking-tight">{portal?.shop.name ?? 'Your shop'}</span>
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--roviq-muted)]">Customer page</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
        {error && <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{notice}</p>}
        {!portal && !error && <p className="roviq-muted">Loading…</p>}
        {portal && (
          <>
            <section>
              <h1 className="text-2xl font-bold">{portal.customer.name ? `Hi ${portal.customer.name}` : 'Welcome'}</h1>
              <p className="roviq-muted mt-1 text-sm">{active.length ? `Here’s where things stand with your ${active.length === 1 ? 'vehicle' : 'vehicles'}.` : 'Nothing in the shop right now.'}</p>
            </section>

            {active.map((j) => <JobCard key={j.id} job={j} steps={portal.progressSteps} token={token} onChanged={refresh} setError={setError} />)}

            {portal.upcoming.length > 0 && (
              <section className="roviq-panel p-5"><h2 className="font-semibold">Upcoming visits</h2>
                <ul className="mt-2 space-y-2 text-sm">{portal.upcoming.map((a, i) => <li key={i} className="flex flex-wrap justify-between gap-2"><span>{a.summary ?? 'Service visit'}{a.vehicle ? ` · ${a.vehicle}` : ''}</span><span className="roviq-muted">{time(a.startsAt)}{a.confirmed ? '' : ' (to be confirmed)'}</span></li>)}</ul>
              </section>
            )}

            {portal.recommended.length > 0 && (
              <section className="roviq-panel p-5"><h2 className="font-semibold">Recommended for later</h2>
                <p className="roviq-muted mt-1 text-xs">Work the shop suggested that you chose to leave for now. Call the shop to book it.</p>
                <ul className="mt-2 divide-y divide-[var(--roviq-line)] text-sm">{portal.recommended.map((r) => <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{r.description}{r.vehicle ? <span className="roviq-muted"> · {r.vehicle}</span> : null}</span><span className="tabular-nums">about {money(r.estimate)}</span></li>)}</ul>
              </section>
            )}

            {history.length > 0 && (
              <section className="roviq-panel p-5"><h2 className="font-semibold">Service history</h2>
                <ul className="mt-2 divide-y divide-[var(--roviq-line)] text-sm">{history.map((j) => <li key={j.id} className="flex flex-wrap justify-between gap-2 py-2"><span className="min-w-0">{j.concern ?? 'Service'}<span className="roviq-muted block text-xs">{j.vehicle} · {day(j.completedAt ?? j.openedAt)}{j.odometer ? ` · ${j.odometer.toLocaleString()} mi` : ''}</span></span><span className="tabular-nums">{money(j.totals.approved)}</span></li>)}</ul>
              </section>
            )}

            <p className="roviq-muted text-center text-xs">{[portal.shop.address, portal.shop.city, portal.shop.region].filter(Boolean).join(', ')}<br />Powered by ROVIQ</p>
          </>
        )}
      </main>
    </div>
  );
}
