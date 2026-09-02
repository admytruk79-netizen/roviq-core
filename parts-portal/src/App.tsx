import { useEffect, useRef, useState, type FormEvent } from 'react';

type Principal = { role: string; actorId?: string | null };
type Order = { id: string; case_id: string; status: string; needed_by?: string; created_at?: string };
type OrderItem = { id: string; sku: string; part_number?: string | null; description?: string | null; quantity: number; status: string };
type OrderDetail = { order: Order; items: OrderItem[] };
type Spatial = { parts_origin?: unknown; destination?: unknown; route_context?: Record<string, unknown> };

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = 'roviq_parts_token';
const PRINCIPAL = 'roviq_parts_principal';

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN);
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `request_failed_${response.status}`);
  }
  return response.json();
}

function loc(value: unknown) {
  if (!value) return 'Not available yet';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const text = [object.name, object.label, object.address, object.formatted_address, object.description]
      .find((item) => typeof item === 'string');
    if (typeof text === 'string') return text;
  }
  return 'Location attached to case';
}

function SpatialView({ caseId }: { caseId: string }) {
  const [spatial, setSpatial] = useState<Spatial | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    req<{ spatial: Spatial }>(`/api/maintenance/cases/${caseId}/spatial`)
      .then((result) => { if (live) setSpatial(result.spatial); })
      .catch(() => { if (live) setError('Fulfilment route context is not available yet.'); });
    return () => { live = false; };
  }, [caseId]);

  const route = spatial?.route_context ?? {};
  return (
    <section className="panel spatial">
      <span className="eyebrow">Selected order</span>
      <h2>Fulfilment route</h2>
      <p>Only the case-linked parts origin, delivery destination and ETA are shown.</p>
      {error ? <div className="spatial-empty">{error}</div> : (
        <div className="spatial-grid">
          <div><span>Parts origin</span><strong>{loc(spatial?.parts_origin)}</strong></div>
          <div><span>Delivery destination</span><strong>{loc(spatial?.destination)}</strong></div>
          <div><span>Distance</span><strong>{String(route.distanceMiles ?? '—')} mi</strong></div>
          <div><span>ETA</span><strong>{String(route.etaMinutes ?? '—')} min</strong></div>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [principal, setPrincipal] = useState<Principal | null>(() => {
    try { return JSON.parse(localStorage.getItem(PRINCIPAL) ?? 'null'); } catch { return null; }
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);
  // Mirrors `selected` for reads inside async closures (e.g. action() below): a closure captures
  // `selected` as of the render that started it, so a selection change made while that action's
  // request is still in flight would go unnoticed by an `=== selected` check on the stale value.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const [sku, setSku] = useState('');
  const [description, setDescription] = useState('');
  const [quantityOnHand, setQuantityOnHand] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [savingInventory, setSavingInventory] = useState(false);

  async function login(event: FormEvent) {
    event.preventDefault();
    try {
      setError('');
      const result = await req<{ accessToken: string; principal: Principal }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password })
      });
      let session = result;
      if (result.principal.role === 'admin') {
        localStorage.setItem(TOKEN, result.accessToken);
        session = await req<{ accessToken: string; principal: Principal }>('/api/admin/testing/parts-session', {
          method: 'POST', body: '{}'
        });
      }
      if (session.principal.role !== 'parts' || !session.principal.actorId) {
        throw new Error('This portal requires a parts-vendor account.');
      }
      localStorage.setItem(TOKEN, session.accessToken);
      localStorage.setItem(PRINCIPAL, JSON.stringify(session.principal));
      setPrincipal(session.principal);
    } catch (err) {
      localStorage.removeItem(TOKEN);
      localStorage.removeItem(PRINCIPAL);
      setError(err instanceof Error ? err.message : 'Unable to sign in');
    }
  }

  async function load() {
    try {
      setError('');
      const result = await req<{ orders: Order[] }>('/api/parts/me/orders');
      setOrders(result.orders);
      if (!selected && result.orders[0]) setSelected(result.orders[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load orders');
    }
  }

  async function loadDetail(orderId: string) {
    const requestId = ++detailRequest.current;
    setDetailLoading(true);
    try {
      const result = await req<OrderDetail>(`/api/maintenance/parts-orders/${orderId}`);
      if (requestId !== detailRequest.current) return;
      setDetail(result);
      if (result.items[0]) chooseItem(result.items[0]);
      else clearInventoryForm();
    } catch (err) {
      if (requestId !== detailRequest.current) return;
      setDetail(null);
      setError(err instanceof Error ? err.message : 'Unable to load order detail');
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }

  useEffect(() => { if (principal) void load(); }, [principal]);
  useEffect(() => { if (principal && selected) void loadDetail(selected); }, [principal, selected]);

  function clearInventoryForm() {
    setSku('');
    setDescription('');
    setQuantityOnHand('');
    setUnitPrice('');
  }

  function selectOrder(orderId: string) {
    setError('');
    setMessage('');
    if (orderId === selected) return;
    detailRequest.current += 1;
    setSelected(orderId);
    setDetail(null);
    setDetailLoading(true);
    clearInventoryForm();
  }

  function chooseItem(item: OrderItem) {
    setSku(item.sku);
    setDescription(item.description ?? '');
    setQuantityOnHand(String(item.quantity));
    setUnitPrice('');
  }

  async function saveInventory(event: FormEvent) {
    event.preventDefault();
    const quantity = Number(quantityOnHand);
    const price = unitPrice.trim() ? Number(unitPrice) : undefined;
    if (!sku.trim() || !Number.isInteger(quantity) || quantity < 0 || (price !== undefined && (!Number.isFinite(price) || price < 0))) {
      setError('Enter a valid SKU, stock quantity and price.');
      return;
    }
    setSavingInventory(true);
    setError('');
    setMessage('');
    try {
      await req('/api/parts/inventory', {
        method: 'PUT',
        body: JSON.stringify({
          sku: sku.trim(),
          description: description.trim() || undefined,
          quantityOnHand: quantity,
          unitPrice: price,
          currency: 'USD'
        })
      });
      setMessage(`Inventory saved for ${sku.trim()}. You can reserve the assigned order when stock is sufficient.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update inventory');
    } finally {
      setSavingInventory(false);
    }
  }

  async function action(id: string, kind: string) {
    try {
      setError('');
      setMessage('');
      if (kind === 'reserve') {
        await req(`/api/parts/orders/${id}/reserve`, { method: 'POST', body: '{}' });
        setMessage('Required inventory reserved for this order.');
      } else {
        await req(`/api/parts/orders/${id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: kind })
        });
        setMessage(`Order marked ${kind}.`);
      }
      await load();
      // Only refresh the detail panel if this action was on the order still currently selected --
      // read the live ref, not the `selected` state closed over when this action() call started,
      // since the user may have switched selection while the request was in flight.
      if (id === selectedRef.current) await loadDetail(id);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Update failed';
      setError(raw.startsWith('inventory_unavailable:')
        ? `Inventory is not sufficient for SKU ${raw.split(':')[1]}. Update stock below, then reserve again.`
        : raw);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN);
    localStorage.removeItem(PRINCIPAL);
    setPrincipal(null);
  }

  if (!principal) return <Login {...{ email, setEmail, password, setPassword, show, setShow, error, login }} />;

  const active = orders.find((order) => order.id === selected) ?? orders[0] ?? null;
  return (
    <div className="shell">
      <Header logout={logout} />
      <main>
        <span className="eyebrow">Fulfilment</span>
        <h1>Parts orders</h1>
        <p>Confirm inventory, reserve stock and keep fulfilment status current. Geography is restricted to the selected case order.</p>
        {error && <div className="error">{error}</div>}
        {message && <div className="success">{message}</div>}

        <div className="grid">
          {orders.map((order) => (
            <article className={`card order-card ${active?.id === order.id ? 'active' : ''}`} key={order.id}>
              <button type="button" className="order-select" onClick={() => selectOrder(order.id)}>
                <span className="pill">{order.status.replaceAll('_', ' ')}</span>
                <h3>Order {order.id.slice(0, 8)}</h3>
                <p>Case {order.case_id.slice(0, 8)}</p>
              </button>
              <div className="actions">
                {order.status === 'supplier_assigned' && <button className="primary" onClick={() => void action(order.id, 'reserve')}>Reserve stock</button>}
                {order.status === 'reserved' && <button className="primary" onClick={() => void action(order.id, 'ordered')}>Mark ordered</button>}
                {order.status === 'ordered' && <button className="primary" onClick={() => void action(order.id, 'shipped')}>Mark shipped</button>}
                {order.status === 'shipped' && <button className="primary" onClick={() => void action(order.id, 'delivered')}>Mark delivered</button>}
              </div>
            </article>
          ))}
        </div>

        {active && (
          <section className="panel inventory-panel">
            <span className="eyebrow">Order inventory</span>
            <h2>Confirm stock before reservation</h2>
            <p>Set stock for the requested SKU, then reserve the order. ROVIQ will reject reservation if available inventory is insufficient.</p>
            {detailLoading ? <div className="spatial-empty">Loading requested items…</div> : (
              <>
                <div className="item-list">
                  {(detail?.items ?? []).map((item) => (
                    <button type="button" className={`item-row ${sku === item.sku ? 'active' : ''}`} key={item.id} onClick={() => chooseItem(item)}>
                      <span><strong>{item.sku}</strong><small>{item.description ?? item.part_number ?? 'Requested part'}</small></span>
                      <span><small>Required</small><strong>{item.quantity}</strong></span>
                      <span><small>Status</small><strong>{item.status.replaceAll('_', ' ')}</strong></span>
                    </button>
                  ))}
                </div>
                <form className="inventory-form" onSubmit={saveInventory}>
                  <label>SKU<input required value={sku} onChange={(event) => setSku(event.target.value)} /></label>
                  <label>Stock on hand<input required type="number" min="0" step="1" value={quantityOnHand} onChange={(event) => setQuantityOnHand(event.target.value)} /></label>
                  <label>Unit price (USD)<input type="number" min="0" step="0.01" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} placeholder="Optional" /></label>
                  <label className="inventory-description">Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
                  <button className="secondary inventory-save" type="submit" disabled={savingInventory}>{savingInventory ? 'Saving…' : 'Save inventory'}</button>
                </form>
              </>
            )}
          </section>
        )}

        {active && <SpatialView caseId={active.case_id} />}
      </main>
    </div>
  );
}

function Login(props: any) {
  return (
    <div className="shell login">
      <form className="panel login-card" onSubmit={props.login}>
        <Brand />
        <span className="eyebrow">Parts vendor portal</span>
        <h1>Sign in</h1>
        <p>Confirm, fulfil and deliver without losing the service context.</p>
        <label>Email<input type="email" required autoComplete="email" value={props.email} onChange={(event: any) => props.setEmail(event.target.value)} /></label>
        <label>Password<div className="password"><input type={props.show ? 'text' : 'password'} required autoComplete="current-password" value={props.password} onChange={(event: any) => props.setPassword(event.target.value)} /><button type="button" onClick={() => props.setShow(!props.show)}>{props.show ? 'Hide' : 'Show'}</button></div></label>
        {props.error && <div className="error">{props.error}</div>}
        <button className="primary">Enter portal</button>
      </form>
    </div>
  );
}

function Brand() { return <div className="brand"><span className="mark">R</span><span>ROVIQ</span></div>; }
function Header({ logout }: any) { return <header><Brand /><div><span>Parts</span><button className="secondary" onClick={logout}>Sign out</button></div></header>; }
