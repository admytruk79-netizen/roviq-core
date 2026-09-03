import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatAmount, formatDateTime, formatMinorAmount, humanizeToken } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import type { CustomerSnapshot, PaymentIntent, ServiceCase, ServicePlanResponse, TimelineEvent } from '../lib/types';

type Spatial = {
  origin?: unknown;
  current_vehicle?: unknown;
  destination?: unknown;
  diagnostic_location?: unknown;
  provider_location?: unknown;
  transport_location?: unknown;
  route_context?: Record<string, unknown>;
  updated_at?: string;
};

type Point = { lat: number; lng: number };

const LOCAL_MAP = 'https://roviq-local2.admytruk79.workers.dev';

function point(value: unknown, depth = 0): Point | null {
  if (value == null || depth > 4) return null;
  if (Array.isArray(value) && value.length >= 2) {
    const lng = Number(value[0]);
    const lat = Number(value[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }
  if (typeof value === 'string') {
    const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const lat = Number(v.lat ?? v.latitude);
  const lng = Number(v.lng ?? v.lon ?? v.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  if (Array.isArray(v.coordinates)) {
    const nested = point(v.coordinates, depth + 1);
    if (nested) return nested;
  }
  for (const key of ['location', 'point', 'position', 'geometry', 'coords', 'value']) {
    const nested = point(v[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function locationLabel(value: unknown) {
  if (!value) return 'Not available yet';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const text = [v.name, v.label, v.address, v.formatted_address, v.description].find(x => typeof x === 'string');
    if (typeof text === 'string') return text;
    const p = point(v);
    if (p) return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  }
  return 'Location available';
}

function CustomerLiveMap({ spatial, caseState }: { spatial: Spatial | null; caseState: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const normalizedState = caseState.toLowerCase();
  const vehicle = point(spatial?.current_vehicle) ?? point(spatial?.origin);
  const destination = point(spatial?.destination) ?? point(spatial?.diagnostic_location);
  const responder = normalizedState.startsWith('diagnostic')
    ? point(spatial?.diagnostic_location) ?? point(spatial?.transport_location) ?? point(spatial?.provider_location)
    : point(spatial?.transport_location) ?? point(spatial?.provider_location) ?? point(spatial?.diagnostic_location);
  const responderName = normalizedState.startsWith('tow') ? 'Tow / Valet' : normalizedState.startsWith('diagnostic') ? 'Diagnostic' : 'Service provider';
  const hasMapLocation = Boolean(vehicle || destination || responder);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin === LOCAL_MAP && event.data?.type === 'roviq:tow-map-ready') setMapReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!mapReady || !frameRef.current?.contentWindow) return;
    frameRef.current.contentWindow.postMessage({
      type: 'roviq:tow-map-state',
      state: { tow: responder, pickup: vehicle, destination, follow: true, assigned: Boolean(responder) },
      route: null
    }, LOCAL_MAP);
  }, [mapReady, responder?.lat, responder?.lng, vehicle?.lat, vehicle?.lng, destination?.lat, destination?.lng]);

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Live service map</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">{responder ? `${responderName} location` : 'Tracking your service journey'}</p>
        </div>
        <span className="text-xs text-slate-500">Updates automatically</span>
      </div>
      {hasMapLocation ? (
        <iframe
          ref={frameRef}
          src={`${LOCAL_MAP}/tow-map.html?mode=day`}
          title="ROVIQ live service map"
          className="block h-[320px] w-full border-0 sm:h-[380px]"
          onLoad={() => setMapReady(false)}
        />
      ) : (
        <div className="px-4 py-8 text-center text-sm text-slate-500">The live map will appear as soon as location data is available for this service.</div>
      )}
      <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        {responder ? `${responderName} is sharing a service location for this case.` : 'Provider location will appear here when a field responder begins sharing location.'}
      </div>
    </div>
  );
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

  const loadLive = useCallback(async () => {
    if (!id) return;
    try {
      const [caseRes, spatialRes] = await Promise.all([
        api.get<{ case: ServiceCase; customerSnapshot: CustomerSnapshot }>(`/api/maintenance/cases/${id}`),
        api.get<{ spatial: Spatial }>(`/api/maintenance/cases/${id}/spatial`).catch(() => null)
      ]);
      setCaseData(caseRes.case);
      setSnapshot(caseRes.customerSnapshot);
      setSpatial(spatialRes?.spatial ?? null);
    } catch {
      // Keep the last known customer-visible state during a transient live refresh failure.
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const interval = window.setInterval(() => void loadLive(), 10000);
    const onFocus = () => void loadLive();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadLive]);

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

  if (error) {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-5">
        <p className="text-sm font-semibold text-red-800">We could not open this case.</p>
        <p className="mt-1 text-sm text-red-700">{error}</p>
        <Link to="/cases" className="mt-4 inline-flex text-sm font-medium text-slate-700 underline underline-offset-4">Back to my cases</Link>
      </section>
    );
  }

  if (!caseData) {
    return (
      <div className="space-y-4" aria-live="polite" aria-busy="true">
        <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="h-3 w-28 animate-pulse rounded bg-slate-200" />
          <div className="mt-3 h-7 w-48 animate-pulse rounded bg-slate-200" />
          <div className="mt-3 h-4 w-64 max-w-full animate-pulse rounded bg-slate-100" />
        </section>
        <section className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white" />)}
        </section>
        <p className="text-sm text-slate-500">Loading your service update…</p>
      </div>
    );
  }

  const pendingApproval = plan?.approvals.find((a) => a.state === 'pending' && a.approval_type === 'quote');
  const route = spatial?.route_context ?? {};
  const eta = route.etaMinutes;
  const normalizedState = String(caseData.state).toLowerCase();
  const isComplete = ['completed', 'closed'].includes(normalizedState);
  const statusMessage = snapshot?.customer_message ?? humanizeToken(snapshot?.customer_status ?? caseData.state);
  const nextAction = snapshot?.next_action ?? (isComplete ? 'Your service is complete. No action is required.' : 'We are coordinating the next step.');
  const responderLocation = normalizedState.startsWith('diagnostic')
    ? spatial?.diagnostic_location ?? spatial?.transport_location ?? spatial?.provider_location
    : spatial?.transport_location ?? spatial?.provider_location ?? spatial?.diagnostic_location;
  const responderLabel = normalizedState.startsWith('tow') ? 'Tow / Valet' : normalizedState.startsWith('diagnostic') ? 'Diagnostic' : 'Service provider';

  return (
    <div className="space-y-6">
      <Link to="/cases" className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-800">← My cases</Link>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Current service</p>
            <h1 className="mt-1 text-xl font-semibold capitalize text-slate-900">{caseData.case_type} case</h1>
            <p className="mt-1 text-sm text-slate-500">Opened {formatDateTime(caseData.created_at)}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void refresh()} disabled={refreshing} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Refresh'}</button>
            <StatusBadge state={caseData.state} />
          </div>
        </div>

        <div className={`border-t px-5 py-5 ${isComplete ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}>
          <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${isComplete ? 'text-emerald-700' : 'text-slate-500'}`}>{isComplete ? 'Service complete' : 'What is happening now'}</p>
          <p className={`mt-1 text-base font-semibold ${isComplete ? 'text-emerald-950' : 'text-slate-900'}`}>{statusMessage}</p>
          <div className="mt-3 rounded-lg border border-white/80 bg-white/80 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">What happens next</p>
            <p className="mt-1 text-sm text-slate-700">{nextAction}</p>
            {snapshot?.eta_at && <p className="mt-1 text-xs text-slate-500">Estimated update {formatDateTime(snapshot.eta_at)}</p>}
          </div>
        </div>
      </section>

      {caseData.attributes?.description && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reported issue</p>
          <p className="mt-1 text-sm text-slate-700">{caseData.attributes.description}</p>
        </section>
      )}

      {pendingApproval && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">Your action is needed</p>
          <p className="mt-1 text-base font-semibold text-amber-950">Approval needed: {formatMinorAmount(pendingApproval.amount_minor, pendingApproval.currency)}</p>
          <p className="mt-1 text-sm text-amber-900">Review the service plan below, then approve or decline this estimate.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void decide(pendingApproval.id, 'approved')} disabled={decidingId === pendingApproval.id} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{decidingId === pendingApproval.id ? 'Saving…' : 'Approve'}</button>
            <button onClick={() => void decide(pendingApproval.id, 'rejected')} disabled={decidingId === pendingApproval.id} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Decline</button>
          </div>
          {approvalError && <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{approvalError}</p>}
        </section>
      )}

      <section>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Vehicle journey</h2>
            <p className="mt-1 text-xs text-slate-500">Live case location, responder progress and where your vehicle is headed.</p>
          </div>
        </div>
        <CustomerLiveMap spatial={spatial} caseState={String(caseData.state)} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Vehicle / origin</p><p className="mt-1 text-sm text-slate-700">{locationLabel(spatial?.current_vehicle ?? spatial?.origin)}</p></div>
          <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Service destination</p><p className="mt-1 text-sm text-slate-700">{locationLabel(spatial?.destination ?? spatial?.diagnostic_location)}</p></div>
          <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{responderLabel}</p><p className="mt-1 text-sm text-slate-700">{locationLabel(responderLocation)}</p>{(typeof eta === 'number' || typeof eta === 'string') && <p className="mt-1 text-xs text-slate-500">Estimated travel {String(eta)} min</p>}</div>
        </div>
      </section>

      {plan && (
        <section>
          <h2 className="text-sm font-semibold text-slate-800">Service plan</h2>
          {plan.plan.customer_summary && <p className="mt-1 text-sm text-slate-600">{plan.plan.customer_summary}</p>}
          <ul className="mt-3 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {plan.tasks.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">The service plan is still being prepared.</li>}
            {plan.tasks.map((task) => <li key={task.id} className="flex items-center justify-between gap-4 px-4 py-3"><span className="text-sm text-slate-800">{task.title}</span><span className="text-sm text-slate-500">{formatMinorAmount(task.estimated_amount_minor, task.currency)}</span></li>)}
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-slate-800">Payments</h2>
        <ul className="mt-3 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {payments.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">No payment is due yet.</li>}
          {payments.map((p) => <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3"><span className="text-sm text-slate-800">{p.description ?? 'Payment'}</span><span className="flex items-center gap-2"><StatusBadge state={p.state} /><span className="text-sm text-slate-500">{formatAmount(p.amount, p.currency)}</span></span></li>)}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-800">Activity</h2>
        <ul className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {timeline.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">No activity has been recorded yet.</li>}
          {timeline.map((event) => <li key={event.id} className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0"><span className="text-sm capitalize text-slate-700">{humanizeToken(event.event_type)}</span><span className="text-xs text-slate-400">{formatDateTime(event.occurred_at)}</span></li>)}
        </ul>
      </section>
    </div>
  );
}
