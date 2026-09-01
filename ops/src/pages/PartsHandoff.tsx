import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ActorSummary, PartsOrder, ServiceCase } from '../lib/types';
import { humanizeToken } from '../lib/format';

function actorLabel(actor: ActorSummary) {
  const attributes = actor.attributes ?? {};
  const displayName = [attributes.displayName, attributes.name, attributes.businessName]
    .find(value => typeof value === 'string');
  return typeof displayName === 'string' && displayName.trim()
    ? displayName
    : `Parts provider ${actor.id.slice(0, 8)}`;
}

export function PartsHandoff() {
  const { id } = useParams<{ id: string }>();
  const [caseData, setCaseData] = useState<ServiceCase | null>(null);
  const [orders, setOrders] = useState<PartsOrder[]>([]);
  const [providers, setProviders] = useState<ActorSummary[]>([]);
  const [providerId, setProviderId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [caseRes, orderRes, providerRes] = await Promise.all([
        api.get<{ case: ServiceCase }>(`/api/maintenance/cases/${id}`),
        api.get<{ orders: PartsOrder[] }>(`/api/admin/maintenance/cases/${id}/parts-orders`),
        api.get<{ actors: ActorSummary[] }>('/api/admin/actors?actorType=parts&status=active')
      ]);
      setCaseData(caseRes.case);
      setOrders(orderRes.orders);
      setProviders(providerRes.actors);
      setProviderId(current => current && providerRes.actors.some(actor => actor.id === current) ? current : '');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'You do not have access to this parts handoff.' : 'Could not load parts handoff state.');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const currentOrder = useMemo(
    () => orders.find(order => !['delivered', 'cancelled', 'failed'].includes(order.status)) ?? orders[0] ?? null,
    [orders]
  );

  async function refresh() {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }

  async function assignSupplier(event: FormEvent) {
    event.preventDefault();
    if (!currentOrder || !providerId) return;
    setAssigning(true);
    setMessage(null);
    setError(null);
    try {
      await api.post(`/api/admin/parts-orders/${currentOrder.id}/assign-supplier`, { supplierActorId: providerId });
      const provider = providers.find(actor => actor.id === providerId);
      setMessage(`${provider ? actorLabel(provider) : 'Parts provider'} has been assigned. The order is now visible in the Parts portal.`);
      setProviderId('');
      await load();
    } catch (err) {
      const message = err instanceof ApiError && err.status === 409
        ? 'This parts order is no longer assignable.'
        : 'Could not assign the selected parts provider.';
      setError(message);
    } finally {
      setAssigning(false);
    }
  }

  if (!caseData) return null;
  if (caseData.state !== 'parts_pending' && orders.length === 0) return null;

  const assignedProvider = currentOrder?.supplier_actor_id
    ? providers.find(provider => provider.id === currentOrder.supplier_actor_id) ?? null
    : null;
  const canAssign = currentOrder && ['requested', 'supplier_assigned'].includes(currentOrder.status);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Parts supplier handoff</h2>
          <p className="mt-1 text-sm text-slate-500">Route the repair partner's parts request into the Parts portal without leaving case control.</p>
        </div>
        <div className="flex items-center gap-2"><button type="button" onClick={()=>void refresh()} disabled={refreshing} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Refresh'}</button>{currentOrder && <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">{humanizeToken(currentOrder.status)}</span>}</div>
      </div>

      {message && <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!currentOrder ? (
        <p className="mt-3 text-sm text-slate-500">The case is waiting for the repair partner to submit its parts request.</p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-md bg-slate-50 px-3 py-2"><span className="block text-xs text-slate-400">Order</span><strong>{currentOrder.id.slice(0, 8)}</strong></div>
            <div className="rounded-md bg-slate-50 px-3 py-2"><span className="block text-xs text-slate-400">Status</span><strong>{humanizeToken(currentOrder.status)}</strong></div>
            <div className="rounded-md bg-slate-50 px-3 py-2"><span className="block text-xs text-slate-400">Supplier</span><strong>{assignedProvider ? actorLabel(assignedProvider) : 'Not assigned'}</strong></div>
          </div>

          {canAssign && (
            providers.length === 0 ? (
              <p className="text-sm text-slate-500">No active parts providers are registered yet.</p>
            ) : (
              <form onSubmit={assignSupplier} className="flex flex-wrap items-center gap-2">
                <select value={providerId} onChange={event => setProviderId(event.target.value)} className="min-w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none">
                  <option value="">Select parts provider…</option>
                  {providers.map(provider => <option key={provider.id} value={provider.id}>{actorLabel(provider)}</option>)}
                </select>
                <button type="submit" disabled={!providerId || assigning} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                  {assigning ? 'Assigning…' : currentOrder.supplier_actor_id ? 'Reassign supplier' : 'Assign supplier'}
                </button>
              </form>
            )
          )}

          {currentOrder.supplier_actor_id && !canAssign && <p className="text-sm text-slate-500">The Parts portal now owns fulfilment updates for this order.</p>}
        </div>
      )}
    </section>
  );
}
