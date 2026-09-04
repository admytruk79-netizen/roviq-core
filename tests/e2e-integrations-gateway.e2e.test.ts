import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { authenticateIntegrationKey, publishIntegrationEvent } from '../src/services/integration-gateway.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;

function adminHeaders() {
  return { 'x-roviq-role': 'admin', 'x-admin-api-key': ADMIN_KEY };
}
function actorHeaders(role: string, actorId: string) {
  return { 'x-roviq-role': role, 'x-roviq-actor-id': actorId };
}

type ReceivedRequest = { path: string; body: string; headers: http.IncomingHttpHeaders };

describe('integrations gateway end-to-end lifecycle', () => {
  let app: FastifyInstance;
  let receiverServer: http.Server;
  let receiverBaseUrl: string;
  let received: ReceivedRequest[] = [];
  let flakyAttempts = 0;
  let actorId: string;

  beforeAll(async () => {
    app = await buildApp();

    receiverServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({ path: req.url ?? '', body, headers: req.headers });
        if (req.url === '/always-fail') { res.writeHead(500); res.end('fail'); return; }
        if (req.url === '/flaky') {
          flakyAttempts += 1;
          if (flakyAttempts === 1) { res.writeHead(500); res.end('fail once'); return; }
          res.writeHead(200); res.end('ok'); return;
        }
        res.writeHead(200); res.end('ok');
      });
    });
    await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
    const port = (receiverServer.address() as AddressInfo).port;
    receiverBaseUrl = `http://127.0.0.1:${port}`;

    const actor = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'partner', domain: 'maintenance' } });
    actorId = JSON.parse(actor.body).actor.id;
  });

  afterAll(async () => {
    await pool.end();
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
  });

  it('manages clients and webhook subscriptions with admin-only access, and delivers signed webhooks with retry and dead-lettering', async () => {
    for (const call of [
      { method: 'POST' as const, url: '/api/admin/integrations/clients', payload: { actorId, name: 'x' } },
      { method: 'GET' as const, url: '/api/admin/integrations/clients' },
      { method: 'POST' as const, url: '/api/admin/integrations/webhooks', payload: { actorId, endpointUrl: 'http://example.test/hook' } },
      { method: 'GET' as const, url: '/api/admin/integrations/webhooks' },
      { method: 'POST' as const, url: '/api/admin/integrations/deliver', payload: {} },
      { method: 'GET' as const, url: '/api/admin/integrations/deliveries' }
    ]) {
      const res = await app.inject({ ...call, headers: actorHeaders('customer', actorId) });
      expect(res.statusCode).toBe(403);
    }

    const invalidUrlRes = await app.inject({ method: 'POST', url: '/api/admin/integrations/webhooks', headers: adminHeaders(), payload: { actorId, endpointUrl: 'not-a-url' } });
    expect(invalidUrlRes.statusCode).toBe(400);

    const clientRes = await app.inject({ method: 'POST', url: '/api/admin/integrations/clients', headers: adminHeaders(), payload: { actorId, name: 'Dealer Integration', scopes: ['read'] } });
    expect(clientRes.statusCode).toBe(201);
    const { client, apiKey } = JSON.parse(clientRes.body);
    expect(apiKey.startsWith('rvq_')).toBe(true);
    expect(client.key_prefix).toBe(apiKey.slice(0, 12));

    const clientsListRes = await app.inject({ method: 'GET', url: '/api/admin/integrations/clients', headers: adminHeaders() });
    const listedClient = JSON.parse(clientsListRes.body).clients.find((c: { id: string }) => c.id === client.id);
    expect(listedClient).toBeTruthy();
    expect(listedClient.key_hash).toBeUndefined();
    expect(listedClient.last_used_at).toBeNull();

    const authenticated = await authenticateIntegrationKey(apiKey);
    expect(authenticated?.id).toBe(client.id);
    const wrongKey = await authenticateIntegrationKey('rvq_totally-wrong-key-value-here');
    expect(wrongKey).toBeNull();
    const tamperedKey = apiKey.slice(0, 12) + 'x'.repeat(apiKey.length - 12);
    const tampered = await authenticateIntegrationKey(tamperedKey);
    expect(tampered).toBeNull();

    const afterAuthRes = await app.inject({ method: 'GET', url: '/api/admin/integrations/clients', headers: adminHeaders() });
    const afterAuthClient = JSON.parse(afterAuthRes.body).clients.find((c: { id: string }) => c.id === client.id);
    expect(afterAuthClient.last_used_at).not.toBeNull();

    const scopedSubRes = await app.inject({
      method: 'POST', url: '/api/admin/integrations/webhooks', headers: adminHeaders(),
      payload: { actorId, endpointUrl: `${receiverBaseUrl}/hook`, eventTypes: ['case.test_event'] }
    });
    expect(scopedSubRes.statusCode).toBe(201);
    const { subscription: scopedSub, signingSecret } = JSON.parse(scopedSubRes.body);

    const wildcardSubRes = await app.inject({
      method: 'POST', url: '/api/admin/integrations/webhooks', headers: adminHeaders(),
      payload: { actorId, endpointUrl: `${receiverBaseUrl}/hook`, eventTypes: [] }
    });
    const { subscription: wildcardSub } = JSON.parse(wildcardSubRes.body);

    const subsListRes = await app.inject({ method: 'GET', url: '/api/admin/integrations/webhooks', headers: adminHeaders() });
    const subIds = JSON.parse(subsListRes.body).subscriptions.map((s: { id: string }) => s.id);
    expect(subIds).toEqual(expect.arrayContaining([scopedSub.id, wildcardSub.id]));

    // A matching event type fans out to both a scoped subscription and a wildcard one.
    const matchingEvent = await publishIntegrationEvent({ aggregateType: 'service_case', eventType: 'case.test_event', actorId, payload: { hello: 'world' } });
    const matchingDeliveries = await pool.query('select subscription_id from webhook_deliveries where integration_event_id=$1', [matchingEvent.id]);
    expect(matchingDeliveries.rows.map((r) => r.subscription_id).sort()).toEqual([scopedSub.id, wildcardSub.id].sort());

    // A non-matching event type only fans out to the wildcard subscription.
    const unrelatedEvent = await publishIntegrationEvent({ aggregateType: 'service_case', eventType: 'case.unrelated_event', actorId, payload: {} });
    const unrelatedDeliveries = await pool.query('select subscription_id from webhook_deliveries where integration_event_id=$1', [unrelatedEvent.id]);
    expect(unrelatedDeliveries.rows.map((r) => r.subscription_id)).toEqual([wildcardSub.id]);

    const deliverRes = await app.inject({ method: 'POST', url: '/api/admin/integrations/deliver', headers: adminHeaders(), payload: { limit: 50 } });
    expect(deliverRes.statusCode).toBe(200);
    const delivered = JSON.parse(deliverRes.body).deliveries;
    expect(delivered.length).toBe(3);
    expect(delivered.every((d: { state: string }) => d.state === 'delivered')).toBe(true);

    // The delivered webhook is correctly HMAC-signed with the subscription's own secret.
    const scopedRequest = received.find((r) => r.body.includes('case.test_event'));
    expect(scopedRequest).toBeTruthy();
    const ts = scopedRequest!.headers['x-roviq-timestamp'] as string;
    const expectedSig = `v1=${createHmac('sha256', signingSecret).update(`${ts}.${scopedRequest!.body}`).digest('hex')}`;
    expect(scopedRequest!.headers['x-roviq-signature']).toBe(expectedSig);
    const parsedBody = JSON.parse(scopedRequest!.body);
    expect(parsedBody.type).toBe('case.test_event');
    expect(parsedBody.payload).toEqual({ hello: 'world' });

    const deliveriesListRes = await app.inject({ method: 'GET', url: '/api/admin/integrations/deliveries', headers: adminHeaders() });
    const deliveriesList = JSON.parse(deliveriesListRes.body).deliveries;
    expect(deliveriesList.filter((d: { state: string }) => d.state === 'delivered' && d.response_code === 200).length).toBeGreaterThanOrEqual(3);

    // A subscription whose endpoint fails once is retried, and the next attempt succeeds.
    const flakySubRes = await app.inject({
      method: 'POST', url: '/api/admin/integrations/webhooks', headers: adminHeaders(),
      payload: { actorId, endpointUrl: `${receiverBaseUrl}/flaky`, eventTypes: ['case.flaky_event'] }
    });
    const { subscription: flakySub } = JSON.parse(flakySubRes.body);
    await publishIntegrationEvent({ aggregateType: 'service_case', eventType: 'case.flaky_event', actorId });

    const firstAttemptRes = await app.inject({ method: 'POST', url: '/api/admin/integrations/deliver', headers: adminHeaders(), payload: { limit: 50 } });
    const firstAttemptDeliveries = JSON.parse(firstAttemptRes.body).deliveries;
    expect(firstAttemptDeliveries.some((d: { state: string }) => d.state === 'retry')).toBe(true);

    await pool.query(`update webhook_deliveries set available_at=now() where subscription_id=$1`, [flakySub.id]);
    const secondAttemptRes = await app.inject({ method: 'POST', url: '/api/admin/integrations/deliver', headers: adminHeaders(), payload: { limit: 50 } });
    const secondAttemptDeliveries = JSON.parse(secondAttemptRes.body).deliveries;
    expect(secondAttemptDeliveries.some((d: { state: string }) => d.state === 'delivered')).toBe(true);

    // A delivery already at its final retry is dead-lettered on the next failure.
    const deadEndSubRes = await app.inject({
      method: 'POST', url: '/api/admin/integrations/webhooks', headers: adminHeaders(),
      payload: { actorId, endpointUrl: `${receiverBaseUrl}/always-fail`, eventTypes: ['case.dead_event'] }
    });
    const { subscription: deadEndSub } = JSON.parse(deadEndSubRes.body);
    const deadEvent = await publishIntegrationEvent({ aggregateType: 'service_case', eventType: 'case.dead_event', actorId });
    await pool.query(
      `update webhook_deliveries set attempt_count=7, state='retry', available_at=now() - interval '1 minute' where subscription_id=$1 and integration_event_id=$2`,
      [deadEndSub.id, deadEvent.id]
    );
    const finalAttemptRes = await app.inject({ method: 'POST', url: '/api/admin/integrations/deliver', headers: adminHeaders(), payload: { limit: 50 } });
    const finalAttemptDeliveries = JSON.parse(finalAttemptRes.body).deliveries;
    expect(finalAttemptDeliveries.some((d: { state: string }) => d.state === 'dead')).toBe(true);
    const deadRow = await pool.query('select state, attempt_count from webhook_deliveries where subscription_id=$1 and integration_event_id=$2', [deadEndSub.id, deadEvent.id]);
    expect(deadRow.rows[0].state).toBe('dead');
    expect(deadRow.rows[0].attempt_count).toBe(8);
  });

  it('scopes real case-lifecycle webhook fan-out to subscribers with a genuine relation to that case', async () => {
    const customerRes = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'customer' } });
    const customerActorId = JSON.parse(customerRes.body).actor.id;
    const outsiderRes = await app.inject({ method: 'POST', url: '/api/admin/actors', headers: adminHeaders(), payload: { actorType: 'partner', domain: 'maintenance' } });
    const outsiderActorId = JSON.parse(outsiderRes.body).actor.id;

    // Both subscriptions are wildcard (empty event_types), so only the case-relation check
    // distinguishes them: the customer is a party to the case that's about to be created, the
    // outsider has no relationship to it at all.
    const relatedSubRes = await app.inject({
      method: 'POST', url: '/api/admin/integrations/webhooks', headers: adminHeaders(),
      payload: { actorId: customerActorId, endpointUrl: `${receiverBaseUrl}/hook`, eventTypes: [] }
    });
    const { subscription: relatedSub } = JSON.parse(relatedSubRes.body);
    const outsiderSubRes = await app.inject({
      method: 'POST', url: '/api/admin/integrations/webhooks', headers: adminHeaders(),
      payload: { actorId: outsiderActorId, endpointUrl: `${receiverBaseUrl}/hook`, eventTypes: [] }
    });
    const { subscription: outsiderSub } = JSON.parse(outsiderSubRes.body);

    const demandRes = await app.inject({
      method: 'POST', url: '/api/demands', headers: actorHeaders('customer', customerActorId),
      payload: { domain: 'maintenance', demandType: 'brake_repair', urgency: 'normal' }
    });
    expect(demandRes.statusCode).toBe(201);
    const caseId = JSON.parse(demandRes.body).case.id;

    const caseEvents = await pool.query(
      `select id from integration_events where aggregate_type='service_case' and aggregate_id=$1 and event_type in ('CASE_CREATED','CASE_TRIAGE')`,
      [caseId]
    );
    expect(caseEvents.rowCount).toBe(2);
    const eventIds = caseEvents.rows.map((r) => r.id);

    const relatedDeliveries = await pool.query(
      `select 1 from webhook_deliveries where subscription_id=$1 and integration_event_id=any($2::uuid[])`,
      [relatedSub.id, eventIds]
    );
    expect(relatedDeliveries.rowCount).toBe(2);

    const outsiderDeliveries = await pool.query(
      `select 1 from webhook_deliveries where subscription_id=$1 and integration_event_id=any($2::uuid[])`,
      [outsiderSub.id, eventIds]
    );
    expect(outsiderDeliveries.rowCount).toBe(0);
  });
});
