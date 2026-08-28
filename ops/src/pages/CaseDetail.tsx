import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatAmount, formatDateTime, formatMinorAmount, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import { CASE_STATES } from '../lib/types';
import type { CustomerSnapshot, PaymentIntent, ServiceCase, ServicePlanResponse, TimelineEvent } from '../lib/types';

export function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const [caseData, setCaseData] = useState<ServiceCase | null>(null);
  const [snapshot, setSnapshot] = useState<CustomerSnapshot>(null);
  const [plan, setPlan] = useState<ServicePlanResponse | null>(null);
  const [payments, setPayments] = useState<PaymentIntent[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [quoteReason, setQuoteReason] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskAmount, setTaskAmount] = useState('');
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [toState, setToState] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [caseRes, planRes, paymentsRes, timelineRes] = await Promise.all([
        api.get<{ case: ServiceCase; customerSnapshot: CustomerSnapshot }>(`/api/maintenance/cases/${id}`),
        api.get<ServicePlanResponse>(`/api/maintenance/cases/${id}/service-plan`).catch(() => null),
        api.get<{ payments: PaymentIntent[] }>(`/api/maintenance/cases/${id}/payments`),
        api.get<{ timeline: TimelineEvent[] }>(`/api/maintenance/cases/${id}/timeline`)
      ]);
      setCaseData(caseRes.case);
      setSnapshot(caseRes.customerSnapshot);
      setPlan(planRes);
      setPayments(paymentsRes.payments);
      setTimeline(timelineRes.timeline);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "You don't have access to this case." : 'Could not load this case.');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitQuote(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    try {
      await api.post(`/api/admin/maintenance/cases/${id}/service-plan/revisions`, {
        changeReason: quoteReason,
        estimatedTotalMinor: Math.round(Number(taskAmount) * 100),
        currency: 'usd',
        tasks: [{ taskType: 'repair', title: taskTitle, estimatedAmountMinor: Math.round(Number(taskAmount) * 100) }]
      });
      setQuoteReason('');
      setTaskTitle('');
      setTaskAmount('');
      await load();
    } catch {
      setQuoteError('Could not save this quote. Check the amount and try again.');
    } finally {
      setQuoteSubmitting(false);
    }
  }

  async function submitTransition(e: FormEvent) {
    e.preventDefault();
    if (!id || !toState) return;
    setTransitioning(true);
    setTransitionError(null);
    try {
      await api.post(`/api/maintenance/cases/${id}/transition`, { toState });
      setToState('');
      await load();
    } catch {
      setTransitionError('That transition was rejected — it may not be valid from the current state.');
    } finally {
      setTransitioning(false);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!caseData) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold capitalize">{caseData.case_type} case</h1>
          <p className="text-xs text-slate-500">Opened {formatDateTime(caseData.created_at)} · Priority {caseData.priority}</p>
        </div>
        <StatusBadge state={caseData.state} />
      </div>

      {snapshot && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm font-medium">{snapshot.customer_message ?? humanizeToken(snapshot.customer_status)}</p>
          {snapshot.next_action && <p className="mt-1 text-sm text-slate-500">Next: {snapshot.next_action}</p>}
          {snapshot.eta_at && <p className="mt-1 text-xs text-slate-400">ETA {formatDateTime(snapshot.eta_at)}</p>}
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">Move case state</h2>
        <form onSubmit={submitTransition} className="mt-2 flex items-center gap-2">
          <select
            value={toState}
            onChange={(e) => setToState(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="">Select a state…</option>
            {CASE_STATES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={!toState || transitioning}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {transitioning ? 'Moving…' : 'Transition'}
          </button>
        </form>
        {transitionError && <p className="mt-2 text-sm text-red-600">{transitionError}</p>}
      </section>

      {plan && (
        <section>
          <h2 className="text-sm font-semibold text-slate-700">Service plan</h2>
          {plan.plan.customer_summary && <p className="mt-1 text-sm text-slate-600">{plan.plan.customer_summary}</p>}
          <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {plan.tasks.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">No tasks yet.</li>}
            {plan.tasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm">{task.title}</span>
                <span className="text-sm text-slate-500">{formatMinorAmount(task.estimated_amount_minor, task.currency)}</span>
              </li>
            ))}
          </ul>

          {plan.approvals.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {plan.approvals.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm capitalize">{a.approval_type} approval</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge state={a.state} />
                    <span className="text-sm text-slate-500">{formatMinorAmount(a.amount_minor, a.currency)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">Propose a quote</h2>
        <form onSubmit={submitQuote} className="mt-2 space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="quoteReason">Reason</label>
            <input
              id="quoteReason"
              required
              value={quoteReason}
              onChange={(e) => setQuoteReason(e.target.value)}
              placeholder="e.g. Diagnosed worn brake pads"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700" htmlFor="taskTitle">Task</label>
              <input
                id="taskTitle"
                required
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="e.g. Replace front brake pads"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>
            <div className="w-32">
              <label className="block text-sm font-medium text-slate-700" htmlFor="taskAmount">Amount (USD)</label>
              <input
                id="taskAmount"
                type="number"
                step="0.01"
                min="0"
                required
                value={taskAmount}
                onChange={(e) => setTaskAmount(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>
          </div>
          {quoteError && <p className="text-sm text-red-600">{quoteError}</p>}
          <button
            type="submit"
            disabled={quoteSubmitting}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {quoteSubmitting ? 'Saving…' : 'Send quote for approval'}
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-700">Payments</h2>
        <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {payments.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">No payments yet.</li>}
          {payments.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm">{p.description ?? 'Payment'}</span>
              <span className="flex items-center gap-2">
                <StatusBadge state={p.state} />
                <span className="text-sm text-slate-500">{formatAmount(p.amount, p.currency)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-700">Activity</h2>
        <ul className="mt-2 space-y-2">
          {timeline.map((event) => (
            <li key={event.id} className="flex justify-between text-sm">
              <span className="capitalize text-slate-700">{humanizeToken(event.event_type)}</span>
              <span className="text-xs text-slate-400">{formatDateTime(event.occurred_at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
