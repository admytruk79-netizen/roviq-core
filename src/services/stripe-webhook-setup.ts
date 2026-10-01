import { pool } from '../db/pool.js';
import { stripeSecretKey } from './stripe-config.js';

// Registers Core's own Stripe webhook using the configured secret key, so nobody has to copy the
// signing secret by hand. Stripe shows that secret only when the endpoint is created; Core keeps it
// in integration_secrets and never returns it.

const SECRET_NAME = 'stripe_webhook_secret';
const DEFAULT_PUBLIC_API_URL = 'https://roviq-core.onrender.com';
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.requires_action',
  'payment_intent.amount_capturable_updated',
  'refund.created',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed'
];

let cached: { value: string | null; at: number } | null = null;

// Secrets a Stripe webhook signature may be checked against: the environment variable, if set,
// and the one Core registered itself.
export async function stripeWebhookSecrets(): Promise<string[]> {
  const env = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!cached || Date.now() - cached.at > 60_000) {
    const r = await pool.query('select value from integration_secrets where name = $1', [SECRET_NAME]).catch(() => ({ rows: [] as { value: string }[] }));
    cached = { value: r.rows[0]?.value ?? null, at: Date.now() };
  }
  return [env, cached.value].filter((s): s is string => Boolean(s));
}

export async function stripeWebhookRegistered() {
  const r = await pool.query('select reference from integration_secrets where name = $1', [SECRET_NAME]).catch(() => ({ rows: [] as { reference: string | null }[] }));
  return r.rows[0] ? { endpointId: r.rows[0].reference } : null;
}

async function stripe(path: string, method: 'GET' | 'POST' | 'DELETE', body?: URLSearchParams) {
  const key = stripeSecretKey();
  if (!key) throw new Error('stripe_not_configured');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: body?.toString(),
    signal: AbortSignal.timeout(15000)
  }).catch(() => { throw new Error('stripe_unreachable'); });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error('stripe_request_failed');
  return json;
}

export function stripeWebhookUrl() {
  const base = (process.env.PUBLIC_API_URL?.trim() || DEFAULT_PUBLIC_API_URL).replace(/\/+$/, '');
  return `${base}/api/payments/webhooks/stripe`;
}

export async function ensureStripeWebhook() {
  const url = stripeWebhookUrl();
  const stored = await stripeWebhookRegistered();
  const list = await stripe('webhook_endpoints?limit=100', 'GET') as { data?: Array<{ id: string; url: string; status?: string }> };
  const existing = (list.data ?? []).filter((e) => e.url === url);

  // Already registered by Core and still present at Stripe: nothing to do.
  if (stored?.endpointId && existing.some((e) => e.id === stored.endpointId)) {
    return { status: 'already_registered' as const, endpointId: stored.endpointId, url, events: STRIPE_WEBHOOK_EVENTS };
  }
  // An endpoint for this URL whose secret Core does not hold cannot be used; replace it.
  for (const e of existing) await stripe(`webhook_endpoints/${encodeURIComponent(e.id)}`, 'DELETE');

  const body = new URLSearchParams({ url, description: 'ROVIQ Core (registered by Core)' });
  STRIPE_WEBHOOK_EVENTS.forEach((event, i) => body.set(`enabled_events[${i}]`, event));
  const created = await stripe('webhook_endpoints', 'POST', body) as { id?: string; secret?: string; livemode?: boolean };
  if (!created.id || !created.secret) throw new Error('stripe_request_failed');

  await pool.query(
    `insert into integration_secrets(name, value, reference) values($1, $2, $3)
     on conflict(name) do update set value = excluded.value, reference = excluded.reference, updated_at = now()`,
    [SECRET_NAME, created.secret, created.id]
  );
  cached = null;
  return { status: existing.length ? 'replaced' as const : 'registered' as const, endpointId: created.id, url, events: STRIPE_WEBHOOK_EVENTS, livemode: created.livemode ?? null };
}
