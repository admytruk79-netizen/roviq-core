import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';

// For a walk-in customer's repair order: send them a private link to approve the estimate and pay
// online, see what's been paid, and record a payment taken at the counter. ROVIQ network jobs are
// approved and paid in the ROVIQ customer app, so this panel only explains that for them.

type Payment = { id: string; amount: string | number; method: string; status: string; note: string | null; paid_at: string | null; created_at: string };
type Payments = { payments: Payment[]; approvedAmount: number; paid: number; balance: number; walkIn: boolean; activeLink: { expires_at: string; last_viewed_at: string | null; decided_at: string | null } | null };

const money = (v: number | string) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(v));
const when = (v: string | null) => v ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(v)) : '—';
const METHOD: Record<string, string> = { card_online: 'Card (online)', card_terminal: 'Card (terminal)', cash: 'Cash', other: 'Other' };
const ERRORS: Record<string, string> = {
  estimate_not_ready: 'Send the estimate for approval first, then share the link.',
  repair_order_customer_required: 'Add the customer to this repair order before sending a link.',
  payment_exceeds_balance: 'That’s more than the customer owes.',
  repair_order_not_payable: 'Payments can be taken once the estimate is approved.'
};

export function ShopOsCustomerPaymentPanel({ repairOrderId, status, isNetworkJob, hasCustomer }: { repairOrderId: string; status: string; isNetworkJob: boolean; hasCustomer: boolean }) {
  const [data, setData] = useState<Payments | null>(null);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'card_terminal' | 'other'>('card_terminal');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    try { const d = await api.get<Payments>(`/api/shop-os/repair-orders/${repairOrderId}/payments`); setData(d); setAmount(d.balance > 0 ? d.balance.toFixed(2) : ''); }
    catch { /* keep last */ }
  }, [repairOrderId]);
  useEffect(() => { setLink(''); setMessage(null); void load(); }, [load, status]);

  async function createLink() {
    setBusy(true); setMessage(null); setCopied(false);
    try {
      const r = await api.post<{ url: string }>(`/api/shop-os/repair-orders/${repairOrderId}/customer-link`, {});
      setLink(r.url); await load();
    } catch (err) { setMessage({ text: ERRORS[(err as Error).message] ?? 'Could not create the link.', error: true }); }
    finally { setBusy(false); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setMessage({ text: 'Copy didn’t work here. Select the link and copy it.', error: true }); }
  }

  async function share() {
    try { await navigator.share({ title: 'Your repair estimate', text: 'Here is your repair estimate. You can approve it and pay here:', url: link }); }
    catch { /* cancelled */ }
  }

  async function record(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMessage(null);
    try {
      await api.post(`/api/shop-os/repair-orders/${repairOrderId}/payments`, { amount: Number(amount), method, note: note.trim() || undefined });
      setNote(''); setMessage({ text: 'Payment recorded.', error: false }); await load();
    } catch (err) { setMessage({ text: ERRORS[(err as Error).message] ?? 'Could not record the payment.', error: true }); }
    finally { setBusy(false); }
  }

  if (isNetworkJob) {
    return <section className="panel p-5"><p className="kicker">Customer & payment</p><h3 className="mt-1 text-lg font-bold">Handled by ROVIQ</h3><p className="muted mt-2 text-sm">This is a ROVIQ network job. The driver approves the quote and pays in the ROVIQ app, and ROVIQ pays you out.</p></section>;
  }
  const canTakePayment = data && !['draft', 'estimate_pending', 'awaiting_approval', 'cancelled'].includes(status) && data.balance > 0;
  return (
    <section className="panel p-5" aria-labelledby={`pay-${repairOrderId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="kicker">Customer & payment</p><h3 id={`pay-${repairOrderId}`} className="mt-1 text-lg font-bold">Approval and payment</h3></div>
        {data && <div className="text-right text-sm"><p>Approved {money(data.approvedAmount)} · Paid {money(data.paid)}</p><p className="text-lg font-black">{data.balance > 0 ? `Owes ${money(data.balance)}` : data.approvedAmount > 0 ? 'Paid in full' : '—'}</p></div>}
      </div>

      <div className="mt-4 rounded-xl border border-white/10 p-4">
        <p className="font-semibold">Customer link</p>
        <p className="muted mt-1 text-sm">The customer opens it on their phone to approve or decline each item, and to pay by card once the work is done. Sending a new link stops the old one.</p>
        {data?.activeLink && !link && <p className="muted mt-2 text-xs">Link active until {when(data.activeLink.expires_at)} · {data.activeLink.decided_at ? `answered ${when(data.activeLink.decided_at)}` : data.activeLink.last_viewed_at ? `opened ${when(data.activeLink.last_viewed_at)}` : 'not opened yet'}</p>}
        {link ? (
          <div className="mt-3 grid gap-2">
            <input className="input text-xs" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Customer link" />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
              {typeof navigator.share === 'function' && <button type="button" className="secondary" onClick={() => void share()}>Share…</button>}
            </div>
            <p className="muted text-xs">Text or email it to the customer. ROVIQ doesn’t send it for you yet.</p>
          </div>
        ) : (
          <button type="button" className="secondary mt-3" disabled={busy || !hasCustomer} onClick={() => void createLink()}>{data?.activeLink ? 'Send a new link' : 'Create customer link'}</button>
        )}
        {!hasCustomer && <p className="muted mt-2 text-xs">Add a customer to this repair order to send them a link.</p>}
      </div>

      {canTakePayment && (
        <form className="mt-4 grid gap-2 rounded-xl border border-white/10 p-4 sm:grid-cols-[.7fr_.9fr_1.4fr_auto]" onSubmit={(e) => void record(e)}>
          <p className="font-semibold sm:col-span-4">Take payment at the counter</p>
          <label className="text-xs"><span className="muted">Amount</span><input className="input mt-1" type="number" min="0.01" step="0.01" max={data!.balance} required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label className="text-xs"><span className="muted">Method</span><select className="input mt-1" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}><option value="card_terminal">Card (terminal)</option><option value="cash">Cash</option><option value="other">Other</option></select></label>
          <label className="text-xs"><span className="muted">Note (optional)</span><input className="input mt-1" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. terminal receipt #" /></label>
          <button className="primary self-end" type="submit" disabled={busy || !amount}>{busy ? 'Saving…' : 'Record payment'}</button>
        </form>
      )}

      {data && data.payments.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm">
          {data.payments.map((p) => <li key={p.id} className="flex justify-between gap-3"><span>{METHOD[p.method] ?? p.method}{p.status === 'pending' ? ' · waiting for card' : ''}{p.note ? ` · ${p.note}` : ''}</span><span className="tabular-nums">{money(p.amount)} · {when(p.paid_at ?? p.created_at)}</span></li>)}
        </ul>
      )}
      {message && <p className={`mt-3 text-sm ${message.error ? 'text-red-300' : 'text-[var(--green)]'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  );
}
