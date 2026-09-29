import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireRole } from '../middleware/principal.js';

// Which external services this Core deployment can actually use. Reports presence and mode only --
// never a key, token or secret value -- so an admin can confirm production wiring without access
// to the hosting dashboards.

function set(name: string) {
  return Boolean(process.env[name]?.trim());
}

function stripeMode(): 'live' | 'test' | 'unknown' | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  return 'unknown';
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
        secretKey: set('STRIPE_SECRET_KEY'),
        webhookSecret: set('STRIPE_WEBHOOK_SECRET'),
        publishableKey: set('STRIPE_PUBLISHABLE_KEY'),
        mode: stripeMode()
      },
      sms: { twilio: set('TWILIO_ACCOUNT_SID') && set('TWILIO_AUTH_TOKEN') && set('TWILIO_FROM_NUMBER') },
      email: { resend: set('RESEND_API_KEY') && set('RESEND_FROM_EMAIL') },
      push: { vapid: set('VAPID_PUBLIC_KEY') && set('VAPID_PRIVATE_KEY') && set('VAPID_SUBJECT') },
      customerWebUrl: process.env.CUSTOMER_WEB_URL ?? null,
      notificationChannels: channels.rows.map((r) => ({ channel: r.channel, provider: r.provider, enabled: r.enabled }))
    };
  });
}
