import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatAmount, formatDateTime, formatMinorAmount, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type { CustomerSnapshot, PaymentIntent, ServiceCase, ServicePlanResponse, TimelineEvent } from '../lib/types';

export function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const [caseData, setCaseData] = useState<ServiceCase | null>(null);
  const [snapshot, setSnapshot] = useState<CustomerSnapshot>(null);
  const [plan, setPlan] = useState<ServicePlanResponse | null>(null);
  const [payments, setPayments] = useState<PaymentIntent[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

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

  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    if (!id) return;
    setDecidingId(approvalId);
    try {
      await api.post(`/api/maintenance/cases/${id}/approvals/${approvalId}/decision`, { decision });
      await load();
    } finally {
      setDecidingId(null);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!caseData) return <p className="text-sm text-slate-500">Loading…</p>;

  const pendingApproval = plan?.approvals.find((a) => a.state === 'pending' && a.approval_type === 'quote');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold capitalize">{caseData.case_type} case</h1>
          <p className="text-xs text-slate-500">Opened {formatDateTime(caseData.created_at)}</p>
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

      {pendingApproval && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Approval needed: {formatMinorAmount(pendingApproval.amount_minor, pendingApproval.currency)}
          </p>
          <p className="mt-1 text-xs text-amber-800">Review the service plan below before approving.</p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide(pendingApproval.id, 'approved')}
              disabled={decidingId === pendingApproval.id}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => decide(pendingApproval.id, 'rejected')}
              disabled={decidingId === pendingApproval.id}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      )}

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
        </section>
      )}

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
