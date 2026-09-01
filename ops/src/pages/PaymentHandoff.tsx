import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatAmount, formatMinorAmount, humanizeToken } from '../lib/format';
import type { PaymentIntent, ServiceCase, ServicePlanResponse } from '../lib/types';

export function PaymentHandoff() {
  const { id } = useParams<{ id: string }>();
  const [caseData, setCaseData] = useState<ServiceCase | null>(null);
  const [plan, setPlan] = useState<ServicePlanResponse | null>(null);
  const [payments, setPayments] = useState<PaymentIntent[]>([]);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('Vehicle service');
  const [creating, setCreating] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [caseRes, planRes, paymentRes] = await Promise.all([
        api.get<{ case: ServiceCase }>(`/api/maintenance/cases/${id}`),
        api.get<ServicePlanResponse>(`/api/maintenance/cases/${id}/service-plan`).catch(() => null),
        api.get<{ payments: PaymentIntent[] }>(`/api/maintenance/cases/${id}/payments`)
      ]);
      setCaseData(caseRes.case);
      setPlan(planRes);
      setPayments(paymentRes.payments);
      if (!amount && planRes?.plan.estimated_total_minor != null) {
        setAmount((planRes.plan.estimated_total_minor / 100).toFixed(2));
      }
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'You do not have access to this payment handoff.' : 'Could not load payment handoff state.');
    }
  }, [id, amount]);

  useEffect(() => { void load(); }, [load]);

  const latestPayment = payments[0] ?? null;
  const latestQuoteApproval = useMemo(
    () => plan?.approvals.find(approval => approval.approval_type === 'quote') ?? null,
    [plan]
  );

  async function createPayment(event: FormEvent) {
    event.preventDefault();
    if (!id) return;
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0) {
      setError('Enter a valid payment amount.');
      return;
    }
    setCreating(true);
    setMessage(null);
    setError(null);
    try {
      await api.post('/api/admin/payments', {
        caseId: id,
        amount: numericAmount,
        currency: 'USD',
        description: description.trim() || 'Vehicle service',
        provider: 'manual',
        metadata: { source: 'ops_case_control' }
      });
      setMessage('Payment intent created. It can now be captured to complete the case.');
      await load();
    } catch (err) {
      const text = err instanceof ApiError && err.status === 409
        ? 'The customer must approve the current quote before payment can be created.'
        : 'Could not create the payment intent.';
      setError(text);
    } finally {
      setCreating(false);
    }
  }

  async function capturePayment() {
    if (!latestPayment) return;
    setCapturing(true);
    setMessage(null);
    setError(null);
    try {
      await api.post(`/api/admin/payments/${latestPayment.id}/state`, { state: 'captured' });
      setMessage('Payment captured. Core has completed the case and updated the customer journey.');
      await load();
    } catch (err) {
      const text = err instanceof ApiError && err.status === 409
        ? 'This payment can no longer move directly to captured.'
        : 'Could not capture the payment.';
      setError(text);
    } finally {
      setCapturing(false);
    }
  }

  if (!caseData) return null;
  if (caseData.state !== 'payment_pending' && payments.length === 0 && caseData.state !== 'completed') return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Customer payment handoff</h2>
          <p className="mt-1 text-sm text-slate-500">Complete the approved service transaction from the same case control surface.</p>
        </div>
        <button type="button" onClick={()=>void load()} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Refresh</button>
      </div>

      {message && <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-md bg-slate-50 px-3 py-2"><span className="block text-xs text-slate-400">Case</span><strong>{humanizeToken(caseData.state)}</strong></div>
        <div className="rounded-md bg-slate-50 px-3 py-2"><span className="block text-xs text-slate-400">Quote approval</span><strong>{latestQuoteApproval ? humanizeToken(latestQuoteApproval.state) : 'Not requested'}</strong></div>
        <div className="rounded-md bg-slate-50 px-3 py-2"><span className="block text-xs text-slate-400">Approved amount</span><strong>{latestQuoteApproval ? formatMinorAmount(latestQuoteApproval.amount_minor, latestQuoteApproval.currency) : '—'}</strong></div>
      </div>

      {!latestPayment && caseData.state === 'payment_pending' && latestQuoteApproval?.state !== 'approved' && (
        <p className="mt-3 text-sm text-slate-500">Waiting for the customer to approve the current quote in the Customer portal.</p>
      )}

      {!latestPayment && caseData.state === 'payment_pending' && latestQuoteApproval?.state === 'approved' && (
        <form onSubmit={createPayment} className="mt-4 grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-[140px_1fr_auto] sm:items-end">
          <label className="text-sm font-medium text-slate-700">Amount USD<input type="number" min="0" step="0.01" required value={amount} onChange={event=>setAmount(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="text-sm font-medium text-slate-700">Description<input value={description} onChange={event=>setDescription(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></label>
          <button disabled={creating} className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">{creating ? 'Creating…' : 'Create payment'}</button>
        </form>
      )}

      {latestPayment && (
        <div className="mt-4 flex flex-col justify-between gap-3 rounded-md border border-slate-200 p-3 sm:flex-row sm:items-center">
          <div><p className="text-sm font-semibold">Payment {latestPayment.id.slice(0, 8)}</p><p className="mt-1 text-sm text-slate-500">{formatAmount(latestPayment.amount, latestPayment.currency)} · {humanizeToken(latestPayment.state)}</p></div>
          {!['captured','cancelled','failed','refunded','partially_refunded'].includes(latestPayment.state) && <button type="button" disabled={capturing} onClick={()=>void capturePayment()} className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">{capturing ? 'Capturing…' : 'Capture & complete case'}</button>}
          {latestPayment.state === 'captured' && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">Captured</span>}
        </div>
      )}
    </section>
  );
}
