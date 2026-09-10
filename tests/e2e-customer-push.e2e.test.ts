import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

// A syntactically valid P-256 uncompressed point (0x04 prefix, 65 bytes) and a 16-byte auth
// secret, both base64url -- the shapes deriveClientKeys() in @block65/webcrypto-web-push
// validates before it will attempt to encrypt anything. Not a real browser subscription; only
// used to prove the adapter builds and sends a correctly-shaped request.
const FAKE_P256DH = 'BDhNqLUa9onVBmAAtHUZyNa4yua13Yd3Kb9DuSLvqrUKY9JkAsUDiWi_i0krvhOcyRKyqBk3P3W4jn_MuvfYN68';
const FAKE_AUTH = 'hArI4wmKK2Gr5OeUttOBWg';
const VAPID_PUBLIC_KEY = 'BAM0JQNDRMQc6mx4hTwKegRQINSNrmq9vni7JcjQ0FLS2_9TsyfM-J1cEb17YhyOmEMHy9IKJkVBH3F0fuTOCH0';
const VAPID_PRIVATE_KEY = '7B32_ctnbEjFGfKFybvwpA3W_O04XNLObkLcf3464c0';

describe('customer web push notifications end-to-end', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    // notification_channel_configs is global, shared state -- e2e-notifications-delivery asserts
    // the 'push' channel starts enabled with the 'internal' no-op provider. Restore that so this
    // file's setup doesn't leak into whichever test file the runner happens to execute next.
    await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/push', headers: adminHeaders(), payload: { provider: 'internal', enabled: true } });
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it('lets an actor manage its own push subscriptions but not another actor\'s', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;

    const forbiddenAdmin = await app.inject({ method: 'POST', url: '/api/me/push-subscriptions', headers: adminHeaders(), payload: { endpoint: 'https://push.example.com/a', keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH } } });
    expect(forbiddenAdmin.statusCode).toBe(403);

    const subscribeRes = await app.inject({
      method: 'POST', url: '/api/me/push-subscriptions', headers: actorHeaders('customer', customerId),
      payload: { endpoint: 'https://push.example.com/customer-a', keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH } }
    });
    expect(subscribeRes.statusCode).toBe(201);

    const row = await pool.query('select actor_id from push_subscriptions where endpoint=$1', ['https://push.example.com/customer-a']);
    expect(row.rows[0]?.actor_id).toBe(customerId);

    // Another actor cannot delete this subscription by guessing its endpoint.
    const otherCustomer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const otherCustomerId = JSON.parse(otherCustomer.body).actor.id;
    await app.inject({ method: 'DELETE', url: '/api/me/push-subscriptions', headers: actorHeaders('customer', otherCustomerId), payload: { endpoint: 'https://push.example.com/customer-a' } });
    const stillThere = await pool.query('select 1 from push_subscriptions where endpoint=$1', ['https://push.example.com/customer-a']);
    expect(stillThere.rowCount).toBe(1);

    const deleteRes = await app.inject({ method: 'DELETE', url: '/api/me/push-subscriptions', headers: actorHeaders('customer', customerId), payload: { endpoint: 'https://push.example.com/customer-a' } });
    expect(deleteRes.statusCode).toBe(200);
    const gone = await pool.query('select 1 from push_subscriptions where endpoint=$1', ['https://push.example.com/customer-a']);
    expect(gone.rowCount).toBe(0);
  });

  it('queues a real push on a customer status change and delivers it once VAPID is configured', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/push', headers: adminHeaders(), payload: { provider: 'webpush', enabled: true } });

    // VAPID isn't configured yet, and the actor has no subscribed device -- the notification must
    // still queue (setCustomerSnapshot never throws on this) and fail with a specific reason.
    const snapshotRes = await app.inject({
      method: 'PUT', url: `/api/admin/cases/${caseId}/customer-snapshot`, headers: adminHeaders(),
      payload: { status: 'diagnostic_started', message: 'A diagnostic technician is reviewing your case.' }
    });
    expect(snapshotRes.statusCode).toBe(200);

    const unconfiguredProcessRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { limit: 200 } });
    const unconfiguredProcessed = JSON.parse(unconfiguredProcessRes.body).processed;
    const pendingOutboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=pending', headers: adminHeaders() });
    const queued = JSON.parse(pendingOutboxRes.body).notifications.find((n: { case_id: string; channel: string }) => n.case_id === caseId && n.channel === 'push');
    expect(queued).toBeTruthy();
    expect(unconfiguredProcessed.find((p: { id: string }) => p.id === queued.id)).toMatchObject({ state: 'retry' });
    const unconfiguredAttemptsRes = await app.inject({ method: 'GET', url: `/api/admin/notifications/${queued.id}/attempts`, headers: adminHeaders() });
    expect(JSON.parse(unconfiguredAttemptsRes.body).attempts[0]).toMatchObject({ error_code: 'webpush_not_configured' });

    // Configure VAPID and subscribe a device, but mock the actual HTTP call to the push service.
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC_KEY;
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE_KEY;
    process.env.VAPID_SUBJECT = 'mailto:ops@roviq.test';
    await app.inject({
      method: 'POST', url: '/api/me/push-subscriptions', headers: actorHeaders('customer', customerId),
      payload: { endpoint: 'https://push.example.com/customer-device-1', keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH } }
    });
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    const secondSnapshotRes = await app.inject({
      method: 'PUT', url: `/api/admin/cases/${caseId}/customer-snapshot`, headers: adminHeaders(),
      payload: { status: 'diagnostic_finding_ready', message: 'Your diagnostic is complete.' }
    });
    expect(secondSnapshotRes.statusCode).toBe(200);

    const configuredProcessRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { limit: 200 } });
    const configuredProcessed = JSON.parse(configuredProcessRes.body).processed;
    const secondOutboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=sent', headers: adminHeaders() });
    const sent = JSON.parse(secondOutboxRes.body).notifications.find((n: { case_id: string; channel: string; payload: { message?: string } }) => n.case_id === caseId && n.channel === 'push' && n.payload?.message === 'Your diagnostic is complete.');
    expect(sent).toBeTruthy();
    expect(configuredProcessed.find((p: { id: string }) => p.id === sent.id)).toMatchObject({ state: 'sent' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://push.example.com/customer-device-1');
    expect(init.headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(init.headers['content-encoding']).toBe('aes128gcm');
  });

  it('deletes a subscription the push service reports as gone (410), instead of retrying it forever', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC_KEY;
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE_KEY;
    process.env.VAPID_SUBJECT = 'mailto:ops@roviq.test';
    await app.inject({
      method: 'POST', url: '/api/me/push-subscriptions', headers: actorHeaders('customer', customerId),
      payload: { endpoint: 'https://push.example.com/expired-device', keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH } }
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 410 })));

    await app.inject({
      method: 'PUT', url: `/api/admin/cases/${caseId}/customer-snapshot`, headers: adminHeaders(),
      payload: { status: 'triage', message: 'Your case is being triaged.' }
    });
    await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { limit: 200 } });

    const remaining = await pool.query('select 1 from push_subscriptions where endpoint=$1', ['https://push.example.com/expired-device']);
    expect(remaining.rowCount).toBe(0);
  });
});
