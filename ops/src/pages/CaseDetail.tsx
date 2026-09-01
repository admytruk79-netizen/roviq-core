import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatAmount, formatDateTime, formatMinorAmount, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type {
  ActorSummary,
  CaseTransition,
  CustomerSnapshot,
  PaymentIntent,
  RoutingCandidate,
  ServiceCase,
  ServicePlanResponse,
  TimelineEvent,
  TransportDispatch
} from '../lib/types';

function actorLabel(actor: ActorSummary) {
  const attributes = actor.attributes ?? {};
  const displayName = [attributes.displayName, attributes.name, attributes.businessName].find((value) => typeof value === 'string');
  return typeof displayName === 'string' && displayName.trim()
    ? displayName
    : `${humanizeToken(actor.actor_type)} ${actor.id.slice(0, 8)}`;
}

export function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const [caseData, setCaseData] = useState<ServiceCase | null>(null);
  const [snapshot, setSnapshot] = useState<CustomerSnapshot>(null);
  const [plan, setPlan] = useState<ServicePlanResponse | null>(null);
  const [payments, setPayments] = useState<PaymentIntent[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [transitions, setTransitions] = useState<CaseTransition[]>([]);
  const [actors, setActors] = useState<ActorSummary[]>([]);
  const [dispatches, setDispatches] = useState<TransportDispatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [quoteReason, setQuoteReason] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskAmount, setTaskAmount] = useState('');
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [toState, setToState] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const [diagnosticActorId, setDiagnosticActorId] = useState('');
  const [dispatchingDiagnostic, setDispatchingDiagnostic] = useState(false);
  const [diagnosticDispatchError, setDiagnosticDispatchError] = useState<string | null>(null);
  const [diagnosticDispatchSuccess, setDiagnosticDispatchSuccess] = useState<string | null>(null);

  const [towActorId, setTowActorId] = useState('');
  const [dispatchingTow, setDispatchingTow] = useState(false);
  const [towDispatchError, setTowDispatchError] = useState<string | null>(null);
  const [towDispatchSuccess, setTowDispatchSuccess] = useState<string | null>(null);

  const [routingCandidates, setRoutingCandidates] = useState<RoutingCandidate[]>([]);
  const [repairActorId, setRepairActorId] = useState('');
  const [routingProviders, setRoutingProviders] = useState(false);
  const [dispatchingRepair, setDispatchingRepair] = useState(false);
  const [repairDispatchError, setRepairDispatchError] = useState<string | null>(null);
  const [repairDispatchSuccess, setRepairDispatchSuccess] = useState<string | null>(null);

  const diagnostics = actors.filter((actor) => actor.actor_type === 'diagnostic');
  const towProviders = actors.filter((actor) => actor.actor_type === 'tow');
  const latestTowDispatch = dispatches.find((dispatch) => dispatch.transport_type === 'tow' && dispatch.status !== 'cancelled') ?? null;
  const repairCandidates = routingCandidates
    .map((candidate) => ({ candidate, actor: actors.find((actor) => actor.id === candidate.actorId) }))
    .filter((entry): entry is { candidate: RoutingCandidate; actor: ActorSummary } => Boolean(entry.actor));

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [caseRes, planRes, paymentsRes, timelineRes, transitionsRes, actorsRes, dispatchRes] = await Promise.all([
        api.get<{ case: ServiceCase; customerSnapshot: CustomerSnapshot }>(`/api/maintenance/cases/${id}`),
        api.get<ServicePlanResponse>(`/api/maintenance/cases/${id}/service-plan`).catch(() => null),
        api.get<{ payments: PaymentIntent[] }>(`/api/maintenance/cases/${id}/payments`),
        api.get<{ timeline: TimelineEvent[] }>(`/api/maintenance/cases/${id}/timeline`),
        api.get<{ transitions: CaseTransition[] }>(`/api/maintenance/cases/${id}/transitions`),
        api.get<{ actors: ActorSummary[] }>('/api/admin/actors?status=active'),
        api.get<{ dispatches: TransportDispatch[] }>(`/api/admin/transport?caseId=${id}`).catch(() => ({ dispatches: [] }))
      ]);
      setCaseData(caseRes.case);
      setSnapshot(caseRes.customerSnapshot);
      setPlan(planRes);
      setPayments(paymentsRes.payments);
      setTimeline(timelineRes.timeline);
      setTransitions(transitionsRes.transitions);
      setActors(actorsRes.actors);
      setDispatches(dispatchRes.dispatches);
      setDiagnosticActorId((current) => current && actorsRes.actors.some((actor) => actor.id === current && actor.actor_type === 'diagnostic') ? current : '');
      setTowActorId((current) => current && actorsRes.actors.some((actor) => actor.id === current && actor.actor_type === 'tow') ? current : '');
      if (caseRes.case.state !== 'provider_selection') {
        setRoutingCandidates([]);
        setRepairActorId('');
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "You don't have access to this case." : 'Could not load this case.');
    }
  }, [id]);

  useEffect(() => {
    void load();
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
      setDiagnosticDispatchSuccess(null);
      setTowDispatchSuccess(null);
      setRepairDispatchSuccess(null);
      await load();
    } catch {
      setTransitionError('That transition was rejected — it may not be valid from the current state.');
    } finally {
      setTransitioning(false);
    }
  }

  async function dispatchDiagnostic(e: FormEvent) {
    e.preventDefault();
    if (!caseData?.demand_id || !diagnosticActorId || caseData.state !== 'diagnostic_pending') return;
    setDispatchingDiagnostic(true);
    setDiagnosticDispatchError(null);
    setDiagnosticDispatchSuccess(null);
    try {
      await api.post('/api/admin/offers', {
        demandId: caseData.demand_id,
        actorId: diagnosticActorId,
        rank: 1,
        ruleBasis: 'ops_manual_diagnostic_dispatch'
      });
      const selectedActor = diagnostics.find((actor) => actor.id === diagnosticActorId);
      setDiagnosticDispatchSuccess(`${selectedActor ? actorLabel(selectedActor) : 'Diagnostic provider'} has been offered this case.`);
      setDiagnosticActorId('');
      await load();
    } catch {
      setDiagnosticDispatchError('Could not send this case to the selected diagnostic provider.');
    } finally {
      setDispatchingDiagnostic(false);
    }
  }

  async function dispatchTow(e: FormEvent) {
    e.preventDefault();
    if (!caseData || !towActorId || !['tow_pending', 'tow_in_progress'].includes(caseData.state)) return;
    setDispatchingTow(true);
    setTowDispatchError(null);
    setTowDispatchSuccess(null);
    try {
      let dispatch = latestTowDispatch;
      if (!dispatch) {
        const created = await api.post<{ dispatch: TransportDispatch }>('/api/admin/transport', {
          caseId: caseData.id,
          transportType: 'tow',
          metadata: { source: 'ops_case_control', demandId: caseData.demand_id ?? null }
        });
        dispatch = created.dispatch;
      }
      if (!['requested', 'declined', 'failed'].includes(dispatch.status)) {
        setTowDispatchSuccess(`Tow dispatch is already ${humanizeToken(dispatch.status)}.`);
        await load();
        return;
      }
      await api.post(`/api/admin/transport/${dispatch.id}/assign`, { providerActorId: towActorId });
      const provider = towProviders.find((actor) => actor.id === towActorId);
      setTowDispatchSuccess(`${provider ? actorLabel(provider) : 'Tow provider'} has been assigned. The job is now visible in Tow / Valet.`);
      setTowActorId('');
      await load();
    } catch (e) {
      const message = e instanceof ApiError && e.status === 409
        ? 'The selected provider cannot take this transport dispatch.'
        : 'Could not create or assign the tow dispatch.';
      setTowDispatchError(message);
    } finally {
      setDispatchingTow(false);
    }
  }

  async function evaluateRepairProviders() {
    if (!caseData?.demand_id || caseData.state !== 'provider_selection') return;
    setRoutingProviders(true);
    setRepairDispatchError(null);
    setRepairDispatchSuccess(null);
    try {
      const result = await api.post<{
        ranked: RoutingCandidate[];
        eligible?: RoutingCandidate[];
        recommendedActorId?: string | null;
        policyRequired?: boolean;
      }>(`/api/admin/demands/${caseData.demand_id}/route`, { createOffer: false });
      const candidates = result.ranked.length ? result.ranked : (result.eligible ?? []);
      setRoutingCandidates(candidates);
      const preferred = result.recommendedActorId ?? candidates[0]?.actorId ?? '';
      setRepairActorId(preferred);
      if (candidates.length === 0) {
        setRepairDispatchError('Core did not find an eligible repair provider for this case.');
      } else if (result.policyRequired) {
        setRepairDispatchSuccess('Eligible providers found. No active ranking policy is available, so Ops must choose from the eligible set.');
      } else {
        setRepairDispatchSuccess('Core evaluated the repair network. Review the ranked provider and send the offer.');
      }
    } catch {
      setRepairDispatchError('Could not evaluate repair providers for this case.');
    } finally {
      setRoutingProviders(false);
    }
  }

  async function dispatchRepair(e: FormEvent) {
    e.preventDefault();
    if (!caseData || caseData.state !== 'provider_selection' || !repairActorId) return;
    setDispatchingRepair(true);
    setRepairDispatchError(null);
    setRepairDispatchSuccess(null);
    try {
      await api.post(`/api/maintenance/cases/${caseData.id}/select-provider`, {
        actorId: repairActorId,
        rationale: { source: 'ops_case_control', reason: 'diagnostic_repair_handoff' }
      });
      const provider = actors.find((actor) => actor.id === repairActorId);
      setRepairDispatchSuccess(`${provider ? actorLabel(provider) : 'Repair provider'} has been selected and offered the case.`);
      setRepairActorId('');
      setRoutingCandidates([]);
      await load();
    } catch (e) {
      const message = e instanceof ApiError && e.status === 409
        ? 'That provider is not eligible under the current routing decision.'
        : 'Could not hand this case to the selected repair provider.';
      setRepairDispatchError(message);
    } finally {
      setDispatchingRepair(false);
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

      {caseData.attributes?.description && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          <span className="font-medium text-slate-700">Customer note: </span>
          {caseData.attributes.description}
        </p>
      )}

      {snapshot && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm font-medium">{snapshot.customer_message ?? humanizeToken(snapshot.customer_status)}</p>
          {snapshot.next_action && <p className="mt-1 text-sm text-slate-500">Next: {snapshot.next_action}</p>}
          {snapshot.eta_at && <p className="mt-1 text-xs text-slate-400">ETA {formatDateTime(snapshot.eta_at)}</p>}
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">Move case state</h2>
        {transitions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No transitions available for your role from this state.</p>
        ) : (
          <form onSubmit={submitTransition} className="mt-2 flex items-center gap-2">
            <select
              value={toState}
              onChange={(e) => setToState(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            >
              <option value="">Select a state…</option>
              {transitions.map((t) => (
                <option key={t.toState} value={t.toState}>{t.toState.replace(/_/g, ' ')}</option>
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
        )}
        {transitionError && <p className="mt-2 text-sm text-red-600">{transitionError}</p>}
      </section>

      {(caseData.state === 'triage' || caseData.state === 'diagnostic_pending') && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Diagnostic handoff</h2>
          {caseData.state === 'triage' ? (
            <p className="mt-2 text-sm text-slate-500">Move this case to diagnostic pending above, then assign an active diagnostic provider here.</p>
          ) : !caseData.demand_id ? (
            <p className="mt-2 text-sm text-red-600">This case is missing its originating demand and cannot be dispatched.</p>
          ) : diagnostics.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No active diagnostic providers are registered yet.</p>
          ) : (
            <form onSubmit={dispatchDiagnostic} className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={diagnosticActorId}
                onChange={(e) => setDiagnosticActorId(e.target.value)}
                className="min-w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
              >
                <option value="">Select diagnostic provider…</option>
                {diagnostics.map((actor) => <option key={actor.id} value={actor.id}>{actorLabel(actor)}</option>)}
              </select>
              <button
                type="submit"
                disabled={!diagnosticActorId || dispatchingDiagnostic}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {dispatchingDiagnostic ? 'Sending…' : 'Send diagnostic offer'}
              </button>
            </form>
          )}
          {diagnosticDispatchError && <p className="mt-2 text-sm text-red-600">{diagnosticDispatchError}</p>}
          {diagnosticDispatchSuccess && <p className="mt-2 text-sm text-emerald-700">{diagnosticDispatchSuccess}</p>}
        </section>
      )}

      {['tow_pending', 'tow_in_progress'].includes(caseData.state) && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Tow handoff</h2>
          {latestTowDispatch && (
            <p className="mt-2 text-sm text-slate-500">
              Current dispatch {latestTowDispatch.id.slice(0, 8)} · {humanizeToken(latestTowDispatch.status)}
              {latestTowDispatch.provider_actor_id ? ` · provider ${latestTowDispatch.provider_actor_id.slice(0, 8)}` : ''}
            </p>
          )}
          {latestTowDispatch?.status === 'delivered' ? (
            <p className="mt-2 text-sm text-slate-500">Transport is delivered. Move the case to provider selection above to coordinate the repair provider.</p>
          ) : towProviders.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No active Tow providers are registered yet.</p>
          ) : latestTowDispatch && !['requested', 'declined', 'failed'].includes(latestTowDispatch.status) ? (
            <p className="mt-2 text-sm text-emerald-700">This transport job is already in the Tow / Valet workflow.</p>
          ) : (
            <form onSubmit={dispatchTow} className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={towActorId}
                onChange={(e) => setTowActorId(e.target.value)}
                className="min-w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
              >
                <option value="">Select Tow provider…</option>
                {towProviders.map((actor) => <option key={actor.id} value={actor.id}>{actorLabel(actor)}</option>)}
              </select>
              <button
                type="submit"
                disabled={!towActorId || dispatchingTow}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {dispatchingTow ? 'Assigning…' : latestTowDispatch ? 'Assign Tow provider' : 'Create and assign tow'}
              </button>
            </form>
          )}
          {towDispatchError && <p className="mt-2 text-sm text-red-600">{towDispatchError}</p>}
          {towDispatchSuccess && <p className="mt-2 text-sm text-emerald-700">{towDispatchSuccess}</p>}
        </section>
      )}

      {caseData.state === 'provider_selection' && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Repair provider handoff</h2>
          {!caseData.demand_id ? (
            <p className="mt-2 text-sm text-red-600">This case is missing its originating demand and cannot be routed.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-500">Run Core routing first. Ops can then select only a provider that is eligible under the current decision.</p>
              <button
                type="button"
                onClick={() => void evaluateRepairProviders()}
                disabled={routingProviders}
                className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {routingProviders ? 'Evaluating…' : 'Evaluate repair providers'}
              </button>
              {repairCandidates.length > 0 && (
                <form onSubmit={dispatchRepair} className="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    value={repairActorId}
                    onChange={(e) => setRepairActorId(e.target.value)}
                    className="min-w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                  >
                    <option value="">Select eligible provider…</option>
                    {repairCandidates.map(({ candidate, actor }, index) => (
                      <option key={candidate.actorId} value={candidate.actorId}>
                        {index === 0 ? 'Recommended · ' : ''}{actorLabel(actor)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={!repairActorId || dispatchingRepair}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {dispatchingRepair ? 'Sending…' : 'Select and offer repair'}
                  </button>
                </form>
              )}
            </>
          )}
          {repairDispatchError && <p className="mt-2 text-sm text-red-600">{repairDispatchError}</p>}
          {repairDispatchSuccess && <p className="mt-2 text-sm text-emerald-700">{repairDispatchSuccess}</p>}
        </section>
      )}

      {caseData.state === 'provider_pending' && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">Repair offer pending</h2>
          <p className="mt-2 text-sm text-slate-500">The selected provider has the offer. Acceptance in the Partner portal advances the case into repair.</p>
        </section>
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
