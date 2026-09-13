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

describe('customer SMS notifications end-to-end', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/sms', headers: adminHeaders(), payload: { provider: 'twilio', enabled: true } });
  });

  afterAll(async () => {
    // notification_channel_configs is global, shared state -- other e2e files (notably
    // e2e-notifications-delivery) assert the 'sms'/'email' channels start disabled. Restore both
    // so this file's setup doesn't leak into whichever test file the runner happens to execute next.
    await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/sms', headers: adminHeaders(), payload: { provider: 'internal', enabled: false } });
    await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/email', headers: adminHeaders(), payload: { provider: 'internal', enabled: false } });
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('lets an actor set and read its own phone number, validates format, and rejects a duplicate', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;

    const forbiddenAdmin = await app.inject({ method: 'PUT', url: '/api/me/phone', headers: adminHeaders(), payload: { phone: '+15551234567' } });
    expect(forbiddenAdmin.statusCode).toBe(403);

    const invalidRes = await app.inject({ method: 'PUT', url: '/api/me/phone', headers: actorHeaders('customer', customerId), payload: { phone: '555-1234' } });
    expect(invalidRes.statusCode).toBe(400);

    const emptyRes = await app.inject({ method: 'GET', url: '/api/me/phone', headers: actorHeaders('customer', customerId) });
    expect(JSON.parse(emptyRes.body).phone).toBeNull();

    const setRes = await app.inject({ method: 'PUT', url: '/api/me/phone', headers: actorHeaders('customer', customerId), payload: { phone: '+15551230001' } });
    expect(setRes.statusCode).toBe(200);
    expect(JSON.parse(setRes.body).phone).toBe('+15551230001');

    const getRes = await app.inject({ method: 'GET', url: '/api/me/phone', headers: actorHeaders('customer', customerId) });
    expect(JSON.parse(getRes.body).phone).toBe('+15551230001');

    const otherCustomer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const otherCustomerId = JSON.parse(otherCustomer.body).actor.id;
    const conflictRes = await app.inject({ method: 'PUT', url: '/api/me/phone', headers: actorHeaders('customer', otherCustomerId), payload: { phone: '+15551230001' } });
    expect(conflictRes.statusCode).toBe(409);
  });

  it('queues a real SMS on a customer status change and delivers it once Twilio is configured', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;
    await app.inject({ method: 'PUT', url: '/api/me/phone', headers: actorHeaders('customer', customerId), payload: { phone: '+15559990001' } });

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    // Twilio isn't configured yet -- the notification must still queue (setCustomerSnapshot never
    // throws on this) and fail delivery with a specific, diagnosable reason, not silently vanish.
    const snapshotRes = await app.inject({
      method: 'PUT', url: `/api/admin/cases/${caseId}/customer-snapshot`, headers: adminHeaders(),
      payload: { status: 'diagnostic_started', message: 'A diagnostic technician is reviewing your case.' }
    });
    expect(snapshotRes.statusCode).toBe(200);

    const unconfiguredProcessRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { limit: 200 } });
    const unconfiguredProcessed = JSON.parse(unconfiguredProcessRes.body).processed;
    const pendingOutboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=pending', headers: adminHeaders() });
    const queued = JSON.parse(pendingOutboxRes.body).notifications.find((n: { case_id: string; channel: string }) => n.case_id === caseId && n.channel === 'sms');
    expect(queued).toBeTruthy();
    expect(unconfiguredProcessed.find((p: { id: string }) => p.id === queued.id)).toMatchObject({ state: 'retry' });
    const unconfiguredAttemptsRes = await app.inject({ method: 'GET', url: `/api/admin/notifications/${queued.id}/attempts`, headers: adminHeaders() });
    expect(JSON.parse(unconfiguredAttemptsRes.body).attempts[0]).toMatchObject({ error_code: 'twilio_not_configured' });

    // Now configure Twilio and mock the actual HTTP call to their API.
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
    process.env.TWILIO_FROM_NUMBER = '+15550000000';
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: 'SMtest123' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    const secondSnapshotRes = await app.inject({
      method: 'PUT', url: `/api/admin/cases/${caseId}/customer-snapshot`, headers: adminHeaders(),
      payload: { status: 'diagnostic_finding_ready', message: 'Your diagnostic is complete.' }
    });
    expect(secondSnapshotRes.statusCode).toBe(200);

    const configuredProcessRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { limit: 200 } });
    const configuredProcessed = JSON.parse(configuredProcessRes.body).processed;
    const secondOutboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=sent', headers: adminHeaders() });
    const sent = JSON.parse(secondOutboxRes.body).notifications.find((n: { case_id: string; channel: string; payload: { message?: string } }) => n.case_id === caseId && n.channel === 'sms' && n.payload?.message === 'Your diagnostic is complete.');
    expect(sent).toBeTruthy();
    expect(configuredProcessed.find((p: { id: string }) => p.id === sent.id)).toMatchObject({ state: 'sent', providerMessageId: 'SMtest123' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('ACtest:test_auth_token').toString('base64')}`);
    const sentParams = new URLSearchParams(init.body as string);
    expect(sentParams.get('To')).toBe('+15559990001');
    expect(sentParams.get('From')).toBe('+15550000000');
    expect(sentParams.get('Body')).toBe('ROVIQ: Your diagnostic is complete.');

    const attemptsRes = await app.inject({ method: 'GET', url: `/api/admin/notifications/${sent.id}/attempts`, headers: adminHeaders() });
    const attempts = JSON.parse(attemptsRes.body).attempts;
    expect(attempts.some((a: { provider_message_id: string }) => a.provider_message_id === 'SMtest123')).toBe(true);

    // The same status change queues an email notification alongside sms, on the same template key.
    const emailOutboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=pending', headers: adminHeaders() });
    const emailQueued = JSON.parse(emailOutboxRes.body).notifications.find((n: { case_id: string; channel: string; payload: { message?: string } }) => n.case_id === caseId && n.channel === 'email' && n.payload?.message === 'Your diagnostic is complete.');
    expect(emailQueued).toBeTruthy();
  });

  it('delivers a customer status email via Resend once the email channel is configured for it', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;
    await app.inject({ method: 'POST', url: '/api/admin/identities', headers: adminHeaders(), payload: { email: `resend-e2e-${customerId}@roviq.test`, password: 'CustomerPassword123!', role: 'customer', actorId: customerId } });

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/email', headers: adminHeaders(), payload: { provider: 'resend', enabled: true } });
    process.env.RESEND_API_KEY = 'resend_test_key';
    process.env.RESEND_FROM_EMAIL = 'updates@roviq.test';
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'email_test123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const snapshotRes = await app.inject({
      method: 'PUT', url: `/api/admin/cases/${caseId}/customer-snapshot`, headers: adminHeaders(),
      payload: { status: 'diagnostic_finding_ready', message: 'Your diagnostic is complete.' }
    });
    expect(snapshotRes.statusCode).toBe(200);

    const processRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { limit: 200 } });
    const processed = JSON.parse(processRes.body).processed;
    const outboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=sent', headers: adminHeaders() });
    const sent = JSON.parse(outboxRes.body).notifications.find((n: { case_id: string; channel: string }) => n.case_id === caseId && n.channel === 'email');
    expect(sent).toBeTruthy();
    expect(processed.find((p: { id: string }) => p.id === sent.id)).toMatchObject({ state: 'sent', providerMessageId: 'email_test123' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.authorization).toBe('Bearer resend_test_key');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toMatchObject({ from: 'updates@roviq.test', to: `resend-e2e-${customerId}@roviq.test`, text: 'Your diagnostic is complete.' });
  });

  it('fails delivery with a specific reason when the customer has no phone on file, instead of silently dropping the message', async () => {
    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerId = JSON.parse(customer.body).actor.id;
    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerId),
      payload: { domain: 'maintenance', demandType: 'wont_start', urgency: 'normal' }
    });
    const caseId = JSON.parse(demandRes.body).case.id as string;

    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
    process.env.TWILIO_FROM_NUMBER = '+15550000000';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await app.inject({
      method: 'PUT', url: `/api/admin/cases/${caseId}/customer-snapshot`, headers: adminHeaders(),
      payload: { status: 'triage', message: 'Your case is being triaged.' }
    });
    const processRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { limit: 200 } });
    const processed = JSON.parse(processRes.body).processed;
    const outboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=pending', headers: adminHeaders() });
    const queued = JSON.parse(outboxRes.body).notifications.find((n: { case_id: string; channel: string }) => n.case_id === caseId && n.channel === 'sms');
    expect(queued).toBeTruthy();
    expect(processed.find((p: { id: string }) => p.id === queued.id)).toMatchObject({ state: 'retry' });
    const attemptsRes = await app.inject({ method: 'GET', url: `/api/admin/notifications/${queued.id}/attempts`, headers: adminHeaders() });
    // 'recipient_phone_missing' can only come from sendTwilioSms's early return before it ever
    // calls fetch, so this already proves no network call was made for this notification. A
    // blanket "fetchSpy was never called at all" assertion would be wrong in a shared outbox --
    // any other eligible row (from an earlier test in this file, this table isn't test-scoped)
    // could legitimately be swept up by the same catch-all POST /api/admin/notifications/process.
    expect(JSON.parse(attemptsRes.body).attempts[0]).toMatchObject({ error_code: 'recipient_phone_missing' });
  });
});
