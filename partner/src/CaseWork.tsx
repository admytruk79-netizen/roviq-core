import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from './api';

type ServiceCase = {
  id: string;
  state: string;
  priority: string;
  updated_at: string;
};

type Approval = {
  id: string;
  approval_type: string;
  state: string;
  amount_minor: number | null;
  currency: string | null;
};

type ServicePlan = {
  plan: {
    status: string;
    customer_summary: string | null;
    estimated_total_minor: number | null;
    currency: string;
  };
  approvals: Approval[];
};

type PartsOrderResponse = {
  order: { id: string; status: string; case_id: string };
};

function money(minor: number | null, currency = 'USD') {
  if (minor == null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);
}

export function CaseWork({ caseId }: { caseId: string }) {
  const [caseData, setCaseData] = useState<ServiceCase | null>(null);
  const [plan, setPlan] = useState<ServicePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [reason, setReason] = useState('');
  const [summary, setSummary] = useState('');
  const [task, setTask] = useState('');
  const [amount, setAmount] = useState('');
  const [quoting, setQuoting] = useState(false);

  const [sku, setSku] = useState('');
  const [partDescription, setPartDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [ordering, setOrdering] = useState(false);
  const [latestOrderId, setLatestOrderId] = useState<string | null>(null);

  const [requestingPayment, setRequestingPayment] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [caseRes, planRes] = await Promise.all([
        api.get<{ case: ServiceCase }>(`/api/maintenance/cases/${caseId}`),
        api.get<ServicePlan>(`/api/maintenance/cases/${caseId}/service-plan`)
      ]);
      setCaseData(caseRes.case);
      setPlan(planRes);
    } catch (err) {
      setError(`Could not load accepted case work: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  const pendingApproval = useMemo(
    () => plan?.approvals.find(approval => approval.approval_type === 'quote' && approval.state === 'pending') ?? null,
    [plan]
  );
  const latestApproval = useMemo(
    () => plan?.approvals.find(approval => approval.approval_type === 'quote') ?? null,
    [plan]
  );

  async function submitQuote(event: FormEvent) {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0) return;
    setQuoting(true);
    setMessage(null);
    setError(null);
    try {
      await api.post(`/api/maintenance/cases/${caseId}/service-plan/revisions`, {
        changeReason: reason,
        customerSummary: summary || undefined,
        estimatedTotalMinor: Math.round(numericAmount * 100),
        currency: 'USD',
        tasks: [{
          taskType: 'repair',
          title: task,
          estimatedAmountMinor: Math.round(numericAmount * 100),
          currency: 'USD'
        }]
      });
      setReason('');
      setSummary('');
      setTask('');
      setAmount('');
      setMessage('Quote sent to the customer for approval.');
      await load();
    } catch (err) {
      setError(`Could not send quote: ${(err as Error).message}`);
    } finally {
      setQuoting(false);
    }
  }

  async function submitParts(event: FormEvent) {
    event.preventDefault();
    const numericQuantity = Math.max(1, Math.floor(Number(quantity)));
    setOrdering(true);
    setMessage(null);
    setError(null);
    try {
      const result = await api.post<PartsOrderResponse>(`/api/maintenance/cases/${caseId}/parts-orders`, {
        items: [{
          sku: sku.trim(),
          quantity: numericQuantity,
          description: partDescription.trim() || undefined
        }],
        attributes: { source: 'partner_portal' }
      });
      setLatestOrderId(result.order.id);
      setSku('');
      setPartDescription('');
      setQuantity('1');
      setMessage(`Parts request ${result.order.id.slice(0, 8)} created. ROVIQ Ops can now assign a supplier.`);
      await load();
    } catch (err) {
      setError(`Could not request parts: ${(err as Error).message}`);
    } finally {
      setOrdering(false);
    }
  }

  async function requestPayment() {
    setRequestingPayment(true);
    setMessage(null);
    setError(null);
    try {
      await api.post(`/api/maintenance/cases/${caseId}/transition`, { toState: 'payment_pending' });
      setMessage('Case moved to payment pending. The customer approval and payment handoff are now active.');
      await load();
    } catch (err) {
      setError(`Could not move this case to payment pending: ${(err as Error).message}`);
    } finally {
      setRequestingPayment(false);
    }
  }

  if (loading && !caseData) {
    return <section className="panel mt-5 p-5 text-sm text-white/60">Loading repair workbench…</section>;
  }

  return <section className="panel mt-5 p-5">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div>
        <p className="kicker">Accepted work</p>
        <h2 className="mt-1 text-xl font-bold">Repair workbench</h2>
        <p className="muted mt-2 text-sm">Build the customer quote, request required parts and advance the case when repair is ready for approval and payment.</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="secondary" disabled={loading} onClick={()=>void load()}>{loading ? 'Refreshing…' : 'Refresh case'}</button>
        <div className="rounded-xl border border-white/10 bg-white/[.035] px-3 py-2 text-right">
          <p className="kicker">Case state</p>
          <p className="mt-1 text-sm font-bold">{caseData?.state.replaceAll('_', ' ') ?? '—'}</p>
        </div>
      </div>
    </div>

    {message && <div className="mt-4 rounded-xl border border-[rgba(140,255,31,.2)] bg-[rgba(140,255,31,.07)] px-4 py-3 text-sm text-white/85">{message}</div>}
    {error && <div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
    {latestApproval && !pendingApproval && <div className="mt-4 rounded-xl border border-white/10 bg-white/[.035] px-4 py-3 text-sm text-white/80">Latest customer quote: <strong>{latestApproval.state.replaceAll('_',' ')}</strong> · {money(latestApproval.amount_minor, latestApproval.currency ?? 'USD')}</div>}

    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <form onSubmit={submitQuote} className="rounded-xl border border-white/10 bg-black/10 p-4">
        <p className="kicker">Customer quote</p>
        <h3 className="mt-1 text-lg font-bold">Propose repair</h3>
        <div className="mt-4 space-y-3">
          <input className="input" required minLength={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reason for quote" />
          <input className="input" value={summary} onChange={e=>setSummary(e.target.value)} placeholder="Customer-facing summary (optional)" />
          <input className="input" required value={task} onChange={e=>setTask(e.target.value)} placeholder="Repair task" />
          <input className="input" required type="number" min="0" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Amount USD" />
          <button className="primary w-full" disabled={quoting}>{quoting ? 'Sending…' : 'Send quote for approval'}</button>
        </div>
        {pendingApproval && <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Customer approval pending · {money(pendingApproval.amount_minor, pendingApproval.currency ?? 'USD')}</div>}
      </form>

      <form onSubmit={submitParts} className="rounded-xl border border-white/10 bg-black/10 p-4">
        <p className="kicker">Parts handoff</p>
        <h3 className="mt-1 text-lg font-bold">Request a part</h3>
        <div className="mt-4 space-y-3">
          <input className="input" required value={sku} onChange={e=>setSku(e.target.value)} placeholder="SKU / internal part code" />
          <input className="input" value={partDescription} onChange={e=>setPartDescription(e.target.value)} placeholder="Part description" />
          <input className="input" required type="number" min="1" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)} placeholder="Quantity" />
          <button className="primary w-full" disabled={ordering || caseData?.state !== 'repair_in_progress'}>{ordering ? 'Creating…' : caseData?.state === 'repair_in_progress' ? 'Request parts' : 'Parts request unavailable in this state'}</button>
        </div>
        {latestOrderId && <p className="muted mt-3 text-xs">Latest request {latestOrderId.slice(0, 8)}</p>}
      </form>
    </div>

    <div className="mt-5 flex flex-col justify-between gap-3 rounded-xl border border-white/10 bg-white/[.025] p-4 sm:flex-row sm:items-center">
      <div><p className="kicker">Next handoff</p><p className="mt-1 text-sm font-semibold">When the quote is ready and repair work is complete, move the case into customer approval / payment.</p></div>
      <button type="button" className="secondary shrink-0" disabled={requestingPayment || caseData?.state !== 'repair_in_progress' || !pendingApproval} onClick={()=>void requestPayment()}>{requestingPayment ? 'Updating…' : 'Request approval & payment'}</button>
    </div>
  </section>;
}
