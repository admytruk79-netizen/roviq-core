import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatAmount, formatDateTime, formatMinorAmount, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type { CustomerSnapshot, PaymentIntent, ServiceCase, ServicePlanResponse, TimelineEvent } from '../lib/types';

type Spatial = {
  origin?: unknown;
  current_vehicle?: unknown;
  destination?: unknown;
  provider_location?: unknown;
  transport_location?: unknown;
  route_context?: Record<string, unknown>;
  updated_at?: string;
};

function locationLabel(value: unknown) {
  if (!value) return 'Not available yet';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v=value as Record<string,unknown>;
    const text=[v.name,v.label,v.address,v.formatted_address,v.description].find(x=>typeof x==='string');
    if (typeof text === 'string') return text;
  }
  return 'Location available';
}

export function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const [caseData, setCaseData] = useState<ServiceCase | null>(null);
  const [snapshot, setSnapshot] = useState<CustomerSnapshot>(null);
  const [plan, setPlan] = useState<ServicePlanResponse | null>(null);
  const [payments, setPayments] = useState<PaymentIntent[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [spatial, setSpatial] = useState<Spatial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [caseRes, planRes, paymentsRes, timelineRes, spatialRes] = await Promise.all([
        api.get<{ case: ServiceCase; customerSnapshot: CustomerSnapshot }>(`/api/maintenance/cases/${id}`),
        api.get<ServicePlanResponse>(`/api/maintenance/cases/${id}/service-plan`).catch(() => null),
        api.get<{ payments: PaymentIntent[] }>(`/api/maintenance/cases/${id}/payments`),
        api.get<{ timeline: TimelineEvent[] }>(`/api/maintenance/cases/${id}/timeline`),
        api.get<{ spatial: Spatial }>(`/api/maintenance/cases/${id}/spatial`).catch(() => null)
      ]);
      setCaseData(caseRes.case);
      setSnapshot(caseRes.customerSnapshot);
      setPlan(planRes);
      setPayments(paymentsRes.payments);
      setTimeline(timelineRes.timeline);
      setSpatial(spatialRes?.spatial ?? null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "You don't have access to this case." : 'Could not load this case.');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function refresh() {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }

  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    if (!id) return;
    setDecidingId(approvalId);
    setApprovalError(null);
    try {
      await api.post(`/api/maintenance/cases/${id}/approvals/${approvalId}/decision`, { decision });
      await load();
    } catch (e) {
      const message = e instanceof ApiError && e.status === 409
        ? 'This approval is no longer pending. Refresh the case and try again.'
        : 'Could not save your decision. Please try again.';
      setApprovalError(message);
    } finally {
      setDecidingId(null);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!caseData) return <p className="text-sm text-slate-500">Loading…</p>;

  const pendingApproval = plan?.approvals.find((a) => a.state === 'pending' && a.approval_type === 'quote');
  const route=spatial?.route_context ?? {};
  const eta=route.etaMinutes;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div><h1 className="text-lg font-semibold capitalize">{caseData.case_type} case</h1><p className="text-xs text-slate-500">Opened {formatDateTime(caseData.created_at)}</p></div>
        <div className="flex items-center gap-2"><button type="button" onClick={()=>void refresh()} disabled={refreshing} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Refresh'}</button><StatusBadge state={caseData.state} /></div>
      </div>

      {caseData.attributes?.description && <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">{caseData.attributes.description}</p>}

      {snapshot && <div className="rounded-lg border border-slate-200 bg-white p-4"><p className="text-sm font-medium">{snapshot.customer_message ?? humanizeToken(snapshot.customer_status)}</p>{snapshot.next_action && <p className="mt-1 text-sm text-slate-500">Next: {snapshot.next_action}</p>}{snapshot.eta_at && <p className="mt-1 text-xs text-slate-400">ETA {formatDateTime(snapshot.eta_at)}</p>}</div>}

      <section>
        <h2 className="text-sm font-semibold text-slate-700">Service progress</h2>
        <p className="mt-1 text-xs text-slate-500">This view shows only the locations and movement relevant to your case.</p>
        <div className="mt-2 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-3">
          <div className="bg-white p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-400">Vehicle / origin</p><p className="mt-1 text-sm text-slate-700">{locationLabel(spatial?.current_vehicle ?? spatial?.origin)}</p></div>
          <div className="bg-white p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-400">Service destination</p><p className="mt-1 text-sm text-slate-700">{locationLabel(spatial?.destination ?? spatial?.provider_location)}</p></div>
          <div className="bg-white p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-400">Transport</p><p className="mt-1 text-sm text-slate-700">{locationLabel(spatial?.transport_location)}</p>{(typeof eta==='number'||typeof eta==='string')&&<p className="mt-1 text-xs text-slate-400">Estimated travel {String(eta)} min</p>}</div>
        </div>
      </section>

      {pendingApproval && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4"><p className="text-sm font-medium text-amber-900">Approval needed: {formatMinorAmount(pendingApproval.amount_minor, pendingApproval.currency)}</p><p className="mt-1 text-xs text-amber-800">Review the service plan below before approving.</p><div className="mt-3 flex gap-2"><button onClick={() => void decide(pendingApproval.id, 'approved')} disabled={decidingId === pendingApproval.id} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{decidingId === pendingApproval.id ? 'Saving…' : 'Approve'}</button><button onClick={() => void decide(pendingApproval.id, 'rejected')} disabled={decidingId === pendingApproval.id} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Decline</button></div>{approvalError && <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{approvalError}</p>}</div>}

      {plan && <section><h2 className="text-sm font-semibold text-slate-700">Service plan</h2>{plan.plan.customer_summary && <p className="mt-1 text-sm text-slate-600">{plan.plan.customer_summary}</p>}<ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">{plan.tasks.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">No tasks yet.</li>}{plan.tasks.map((task) => <li key={task.id} className="flex items-center justify-between px-4 py-3"><span className="text-sm">{task.title}</span><span className="text-sm text-slate-500">{formatMinorAmount(task.estimated_amount_minor, task.currency)}</span></li>)}</ul></section>}

      <section><h2 className="text-sm font-semibold text-slate-700">Payments</h2><ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">{payments.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">No payments yet.</li>}{payments.map((p) => <li key={p.id} className="flex items-center justify-between px-4 py-3"><span className="text-sm">{p.description ?? 'Payment'}</span><span className="flex items-center gap-2"><StatusBadge state={p.state} /><span className="text-sm text-slate-500">{formatAmount(p.amount, p.currency)}</span></span></li>)}</ul></section>

      <section><h2 className="text-sm font-semibold text-slate-700">Activity</h2><ul className="mt-2 space-y-2">{timeline.map((event) => <li key={event.id} className="flex justify-between text-sm"><span className="capitalize text-slate-700">{humanizeToken(event.event_type)}</span><span className="text-xs text-slate-400">{formatDateTime(event.occurred_at)}</span></li>)}</ul></section>
    </div>
  );
}
