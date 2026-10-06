import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';
import { stripeKeyHint, stripeKeyShape, stripeSecretKey } from '../../services/stripe-config.js';
import { ensureStripeWebhook, stripeWebhookRegistered, stripeWebhookSecrets, stripeWebhookUrl } from '../../services/stripe-webhook-setup.js';

// Which external services this Core deployment can actually use. Reports presence and mode only --
// never a key, token or secret value -- so an admin can confirm production wiring without access
// to the hosting dashboards.

function set(name: string) {
  return Boolean(process.env[name]?.trim());
}

function stripeMode(): 'live' | 'test' | 'unknown' | null {
  const shape = stripeKeyShape(stripeSecretKey());
  if (!shape) return null;
  if (shape.endsWith('_live')) return 'live';
  if (shape.endsWith('_test')) return 'test';
  return 'unknown';
}

// One read-only call with the stored key: proves Stripe accepts it. Reports the outcome only.
async function stripeReachable(): Promise<{ ok: boolean; status: number | null; livemode: boolean | null; error: string | null } | null> {
  const key = stripeSecretKey();
  if (!key) return null;
  try {
    const res = await fetch('https://api.stripe.com/v1/balance', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000)
    });
    const json = await res.json().catch(() => ({})) as { livemode?: boolean; error?: { code?: string; type?: string } };
    return {
      ok: res.ok,
      status: res.status,
      livemode: typeof json.livemode === 'boolean' ? json.livemode : null,
      error: res.ok ? null : (json.error?.code ?? json.error?.type ?? 'stripe_error')
    };
  } catch {
    return { ok: false, status: null, livemode: null, error: 'stripe_unreachable' };
  }
}

export async function integrationsStatusRoutes(app: FastifyInstance) {
  app.get('/api/admin/integrations/status', { preHandler: requireRole('admin') }, async () => {
    const channels = await pool.query(
      `select channel, provider, enabled from notification_channel_configs order by channel`
    ).catch(() => ({ rows: [] as { channel: string; provider: string; enabled: boolean }[] }));
    return {
      runtime: 'core',
      revision: process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA ?? null,
      stripe: {
        secretKey: Boolean(stripeSecretKey()),
        webhookSecret: (await stripeWebhookSecrets()).length > 0,
        webhookRegisteredByCore: Boolean(await stripeWebhookRegistered()),
        webhookUrl: stripeWebhookUrl(),
        publishableKey: set('STRIPE_PUBLISHABLE_KEY'),
        mode: stripeMode(),
        keyShape: stripeKeyShape(stripeSecretKey()),
        keyHint: stripeKeyHint(stripeSecretKey()),
        check: await stripeReachable()
      },
      sms: { twilio: set('TWILIO_ACCOUNT_SID') && set('TWILIO_AUTH_TOKEN') && set('TWILIO_FROM_NUMBER') },
      email: { resend: set('RESEND_API_KEY') && set('RESEND_FROM_EMAIL') },
      push: { vapid: set('VAPID_PUBLIC_KEY') && set('VAPID_PRIVATE_KEY') && set('VAPID_SUBJECT') },
      customerWebUrl: process.env.CUSTOMER_WEB_URL ?? null,
      notificationChannels: channels.rows.map((r) => ({ channel: r.channel, provider: r.provider, enabled: r.enabled }))
    };
  });

  // Registers Core's Stripe webhook with the configured key. Returns what was done, never the secret.
  app.post('/api/admin/integrations/stripe-webhook', { preHandler: requireRole('admin') }, async (_req, reply) => {
    try { return await ensureStripeWebhook(); }
    catch (e) {
      const m = e instanceof Error ? e.message : 'stripe_webhook_setup_failed';
      if (m === 'stripe_not_configured') return reply.code(503).send({ error: m });
      if (['stripe_request_failed', 'stripe_unreachable'].includes(m)) return reply.code(502).send({ error: m });
      throw e;
    }
  });
}
