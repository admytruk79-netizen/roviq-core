import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function seedNotification(input: { caseId: string; channel: string; recipientId: string; templateKey: string; payload?: Record<string, unknown>; maxAttempts?: number; attemptCount?: number; availableAt?: string }) {
  const r = await pool.query(
    `insert into notification_outbox(case_id,channel,recipient_type,recipient_id,template_key,payload,max_attempts,attempt_count,available_at)
     values($1,$2,'actor',$3,$4,$5,$6,$7,coalesce($8::timestamptz,now())) returning *`,
    [input.caseId, input.channel, input.recipientId, input.templateKey, JSON.stringify(input.payload ?? {}), input.maxAttempts ?? 5, input.attemptCount ?? 0, input.availableAt ?? null]
  );
  return r.rows[0];
}

describe('notifications delivery end-to-end lifecycle', () => {
  let app: FastifyInstance;
  let customerActorId: string;
  let caseId: string;

  beforeAll(async () => {
    app = await buildApp();

    const customer = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    customerActorId = JSON.parse(customer.body).actor.id;

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    caseId = JSON.parse(demandRes.body).case.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('delivers, retries, dead-letters and renders notifications, with admin-only access enforced', async () => {
    const forbiddenProcessRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: actorHeaders('customer', customerActorId), payload: {} });
    expect(forbiddenProcessRes.statusCode).toBe(403);
    const forbiddenTemplateRes = await app.inject({ method: 'POST', url: '/api/admin/notifications/templates', headers: actorHeaders('customer', customerActorId), payload: { templateKey: 'x', channel: 'push', bodyTemplate: 'x' } });
    expect(forbiddenTemplateRes.statusCode).toBe(403);
    const forbiddenChannelRes = await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/push', headers: actorHeaders('customer', customerActorId), payload: { provider: 'internal', enabled: true } });
    expect(forbiddenChannelRes.statusCode).toBe(403);

    const channelsRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/channels', headers: adminHeaders() });
    const channels: Record<string, { enabled: boolean; provider: string }> = Object.fromEntries(
      JSON.parse(channelsRes.body).channels.map((c: { channel: string; enabled: boolean; provider: string }) => [c.channel, c])
    );
    expect(channels.push.enabled).toBe(true);
    expect(channels.email.enabled).toBe(false);
    expect(channels.sms.enabled).toBe(false);

    const template1Res = await app.inject({
      method: 'POST', url: '/api/admin/notifications/templates', headers: adminHeaders(),
      payload: { templateKey: 'test_notice', channel: 'push', subjectTemplate: 'Hi {{name}}', bodyTemplate: 'Case {{caseId}} status: {{status}}' }
    });
    expect(template1Res.statusCode).toBe(201);
    expect(JSON.parse(template1Res.body).template.version).toBe(1);

    // Re-creating the same template key/channel adds a new, higher version rather than overwriting.
    const template2Res = await app.inject({
      method: 'POST', url: '/api/admin/notifications/templates', headers: adminHeaders(),
      payload: { templateKey: 'test_notice', channel: 'push', subjectTemplate: 'Hello {{name}}', bodyTemplate: 'Updated case {{caseId}} status: {{status}}' }
    });
    expect(template2Res.statusCode).toBe(201);
    expect(JSON.parse(template2Res.body).template.version).toBe(2);

    const pushNotification = await seedNotification({ caseId, channel: 'push', recipientId: customerActorId, templateKey: 'test_notice', payload: { name: 'Alex', caseId, status: 'ready' } });

    const process1Res = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { workerId: 'test-worker' } });
    expect(process1Res.statusCode).toBe(200);
    const processed1 = JSON.parse(process1Res.body).processed;
    expect(processed1.find((p: { id: string }) => p.id === pushNotification.id)).toMatchObject({ state: 'sent' });

    const attemptsRes = await app.inject({ method: 'GET', url: `/api/admin/notifications/${pushNotification.id}/attempts`, headers: adminHeaders() });
    expect(attemptsRes.statusCode).toBe(200);
    const attempts = JSON.parse(attemptsRes.body).attempts;
    expect(attempts.length).toBe(1);
    expect(attempts[0].state).toBe('sent');
    // The latest active template version (2) must be the one rendered, not version 1.
    expect(attempts[0].request_payload.subject).toBe('Hello Alex');
    expect(attempts[0].request_payload.body).toBe(`Updated case ${caseId} status: ready`);

    const sentOutboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=sent', headers: adminHeaders() });
    expect(JSON.parse(sentOutboxRes.body).notifications.some((n: { id: string }) => n.id === pushNotification.id)).toBe(true);

    // A disabled channel fails delivery and is rescheduled for retry, not sent.
    const smsNotification = await seedNotification({ caseId, channel: 'sms', recipientId: customerActorId, templateKey: 'test_notice' });
    const process2Res = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { workerId: 'test-worker' } });
    const processed2 = JSON.parse(process2Res.body).processed;
    expect(processed2.find((p: { id: string }) => p.id === smsNotification.id)).toMatchObject({ state: 'retry' });

    const smsAttemptsRes = await app.inject({ method: 'GET', url: `/api/admin/notifications/${smsNotification.id}/attempts`, headers: adminHeaders() });
    expect(JSON.parse(smsAttemptsRes.body).attempts[0]).toMatchObject({ state: 'failed', error_code: 'channel_disabled' });

    // Its retry backoff pushes availability into the future, so an immediate re-process must not pick it up again.
    const process3Res = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { workerId: 'test-worker' } });
    const processed3 = JSON.parse(process3Res.body).processed;
    expect(processed3.some((p: { id: string }) => p.id === smsNotification.id)).toBe(false);

    // A notification with only one allowed attempt is dead-lettered immediately on failure.
    const deadNotification = await seedNotification({ caseId, channel: 'sms', recipientId: customerActorId, templateKey: 'test_notice', maxAttempts: 1 });
    const process4Res = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { workerId: 'test-worker' } });
    const processed4 = JSON.parse(process4Res.body).processed;
    expect(processed4.find((p: { id: string }) => p.id === deadNotification.id)).toMatchObject({ state: 'dead' });
    const deadOutboxRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/outbox?state=dead', headers: adminHeaders() });
    expect(JSON.parse(deadOutboxRes.body).notifications.some((n: { id: string }) => n.id === deadNotification.id)).toBe(true);

    // Enabling a channel with no registered adapter fails delivery for a different, specific reason.
    const enableEmailRes = await app.inject({ method: 'PUT', url: '/api/admin/notifications/channels/email', headers: adminHeaders(), payload: { provider: 'sendgrid', enabled: true } });
    expect(enableEmailRes.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/admin/notifications/templates', headers: adminHeaders(), payload: { templateKey: 'test_notice', channel: 'email', bodyTemplate: 'Case {{caseId}}' } });
    const noAdapterNotification = await seedNotification({ caseId, channel: 'email', recipientId: customerActorId, templateKey: 'test_notice', maxAttempts: 1 });
    const process5Res = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: adminHeaders(), payload: { workerId: 'test-worker' } });
    const processed5 = JSON.parse(process5Res.body).processed;
    expect(processed5.find((p: { id: string }) => p.id === noAdapterNotification.id)).toMatchObject({ state: 'dead' });
    const noAdapterAttemptsRes = await app.inject({ method: 'GET', url: `/api/admin/notifications/${noAdapterNotification.id}/attempts`, headers: adminHeaders() });
    expect(JSON.parse(noAdapterAttemptsRes.body).attempts[0]).toMatchObject({ error_code: 'provider_not_configured' });

    const missingAttemptsRes = await app.inject({ method: 'GET', url: '/api/admin/notifications/00000000-0000-0000-0000-000000000000/attempts', headers: adminHeaders() });
    expect(missingAttemptsRes.statusCode).toBe(404);
  });
});
