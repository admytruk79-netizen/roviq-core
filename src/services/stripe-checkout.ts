import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { stripeSecretKey } from './stripe-config.js';
import { updatePaymentState } from './payment-state.js';

// Customer card payment through Stripe Checkout. Ops creates the payment for the approved amount;
// the customer pays it on Stripe's hosted page and comes back to the case. A payment is recorded
// as captured only once Stripe itself reports the Checkout Session paid -- either when the
// customer returns (Core asks Stripe) or from Stripe's webhook, whichever arrives first.

const SYSTEM: Principal = { role: 'admin' };
const PAYABLE_STATES = ['created', 'requires_action'];
const DEFAULT_CUSTOMER_ORIGIN = 'https://roviq-core-customer.pages.dev';
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);

type CheckoutSession = {
  id: string;
  url?: string | null;
  status?: string | null;
  payment_status?: string | null;
  payment_intent?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  expires_at?: number | null;
  metadata?: Record<string, string> | null;
};

type PaymentRow = {
  id: string;
  case_id: string;
  customer_actor_id: string | null;
  case_customer_actor_id: string | null;
  provider: string;
  provider_intent_id: string | null;
  amount: string;
  currency: string;
  state: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
};

function minorFactor(currency: string) {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}
function toMinor(amount: number, currency: string) {
  return Math.round(amount * minorFactor(currency));
}

// Where Stripe sends the customer back. Only known customer-app origins are accepted, so the
// endpoint cannot be used to bounce someone to another site.
export function customerReturnOrigin(requestOrigin: string | undefined) {
  const allowed = new Set([DEFAULT_CUSTOMER_ORIGIN, ...(process.env.CUSTOMER_APP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)]);
  if (process.env.ALLOW_DEV_HEADERS === 'true') {
    if (requestOrigin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)) return requestOrigin;
  }
  if (requestOrigin && allowed.has(requestOrigin)) return requestOrigin;
  return DEFAULT_CUSTOMER_ORIGIN;
}

async function loadCustomerPayment(principal: Principal, paymentId: string): Promise<PaymentRow> {
  if (principal.role !== 'customer' || !principal.actorId) throw new Error('forbidden');
  const r = await pool.query(
    `select p.*, sc.customer_actor_id as case_customer_actor_id
       from payment_intents p join service_cases sc on sc.id = p.case_id
      where p.id = $1`,
    [paymentId]
  );
  const row = r.rows[0] as PaymentRow | undefined;
  // Someone else's payment reads as missing, not forbidden.
  if (!row || (row.case_customer_actor_id !== principal.actorId && row.customer_actor_id !== principal.actorId)) throw new Error('payment_not_found');
  return row;
}

async function stripe(path: string, init: { method?: 'GET' | 'POST'; body?: URLSearchParams; idempotencyKey?: string } = {}) {
  const secret = stripeSecretKey();
  if (!secret) throw new Error('stripe_not_configured');
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${secret}`,
        ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {})
      },
      body: init.body?.toString(),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('stripe_unreachable');
  }
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const error = new Error('stripe_request_failed') as Error & { providerResponse?: unknown };
    error.providerResponse = json;
    throw error;
  }
  return json;
}

export async function createCustomerCheckout(principal: Principal, paymentId: string, requestOrigin?: string) {
  const p = await loadCustomerPayment(principal, paymentId);
  if (!PAYABLE_STATES.includes(p.state)) throw new Error('payment_not_payable');
  // A payment Ops already opened as a Stripe PaymentIntent is paid through that intent, not Checkout.
  if (p.provider_intent_id) throw new Error('payment_not_payable');
  const amount = Number(p.amount);
  if (!(amount > 0)) throw new Error('payment_not_payable');

  const metadata = p.metadata ?? {};
  const open = metadata.checkoutSession as { id?: string; url?: string; expiresAt?: number } | undefined;
  if (open?.url && open.expiresAt && open.expiresAt * 1000 > Date.now() + 2 * 60 * 1000) {
    return { checkoutUrl: open.url, sessionId: open.id };
  }

  const origin = customerReturnOrigin(requestOrigin);
  const caseUrl = `${origin}/cases/${p.case_id}`;
  const currency = p.currency.toLowerCase();
  const body = new URLSearchParams({
    mode: 'payment',
    client_reference_id: p.id,
    success_url: `${caseUrl}?payment=success&payment_id=${p.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${caseUrl}?payment=cancelled`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(toMinor(amount, p.currency)),
    'line_items[0][price_data][product_data][name]': p.description?.trim() || 'ROVIQ vehicle service',
    'metadata[roviq_payment_intent_id]': p.id,
    'metadata[roviq_case_id]': p.case_id,
    'payment_intent_data[metadata][roviq_payment_intent_id]': p.id,
    'payment_intent_data[metadata][roviq_case_id]': p.case_id
  });
  const attempt = Number(metadata.checkoutAttempts ?? 0) + 1;
  const session = await stripe('checkout/sessions', { method: 'POST', body, idempotencyKey: `roviq-checkout:${p.id}:${attempt}` }) as CheckoutSession;
  if (!session.id || !session.url) throw new Error('stripe_request_failed');

  await pool.query(
    `update payment_intents
        set provider = case when provider_intent_id is null then 'stripe' else provider end,
            metadata = coalesce(metadata,'{}'::jsonb) || $2::jsonb,
            updated_at = now()
      where id = $1`,
    [p.id, JSON.stringify({ checkoutAttempts: attempt, checkoutSession: { id: session.id, url: session.url, expiresAt: session.expires_at ?? null } })]
  );
  return { checkoutUrl: session.url, sessionId: session.id };
}

// Records a paid Checkout Session against its ROVIQ payment. Used by the customer's return and by
// the webhook; safe to run more than once for the same session.
export async function applyCheckoutSession(session: CheckoutSession, source: 'return' | 'webhook') {
  const paymentId = session.metadata?.roviq_payment_intent_id;
  if (!paymentId) throw new Error('checkout_session_unlinked');
  const r = await pool.query('select id, currency, amount, state, provider_intent_id from payment_intents where id = $1', [paymentId]);
  const p = r.rows[0];
  if (!p) throw new Error('payment_not_found');
  if (session.status !== 'complete' || session.payment_status !== 'paid') return { paymentId, state: p.state as string, paid: false };

  const currency = String(p.currency).toUpperCase();
  if (String(session.currency ?? '').toUpperCase() !== currency) throw new Error('checkout_currency_mismatch');
  if (typeof session.amount_total !== 'number' || session.amount_total !== toMinor(Number(p.amount), currency)) throw new Error('checkout_amount_mismatch');
  const paid = Number(p.amount);

  if (session.payment_intent && !p.provider_intent_id) {
    await pool.query(
      `update payment_intents set provider = 'stripe', provider_intent_id = $2, updated_at = now()
        where id = $1 and provider_intent_id is null`,
      [paymentId, session.payment_intent]
    );
  }
  const updated = await updatePaymentState(SYSTEM, paymentId, 'captured', {
    amount: paid,
    providerEventId: `checkout:${session.id}`,
    payload: { provider: 'stripe', source, checkoutSessionId: session.id, stripePaymentIntentId: session.payment_intent ?? null }
  });
  return { paymentId, state: updated.state as string, paid: true };
}

// The customer is back from Stripe: ask Stripe (never the browser) whether the session was paid.
export async function confirmCustomerCheckout(principal: Principal, paymentId: string, sessionId: string) {
  const p = await loadCustomerPayment(principal, paymentId);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error('checkout_session_invalid');
  const session = await stripe(`checkout/sessions/${encodeURIComponent(sessionId)}`) as CheckoutSession;
  if (session.metadata?.roviq_payment_intent_id !== p.id) throw new Error('checkout_session_invalid');
  return applyCheckoutSession(session, 'return');
}
