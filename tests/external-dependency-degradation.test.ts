import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { hmacSha256Hex, pingCore, processWebhookOutboxNative } from '../cloudflare/worker.js';
import { handleLocalCoreRequest } from '../cloudflare/local-adapter.js';
import { evaluateAssessmentAuthority } from '../src/services/ai-authority.js';

// A minimal stand-in for the Neon serverless driver's tagged-template `sql` function -- just
// enough to drive processWebhookOutboxNative's control flow without a live database. Each call
// records the literal SQL text (joined on the interpolation points) and the interpolated values,
// and returns the next canned result in order.
function fakeSql(results: unknown[][]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    const result = results[calls.length - 1];
    if (result === undefined) throw new Error(`fakeSql: no canned result for call ${calls.length}`);
    return result;
  };
  return { tag, calls };
}

describe('external dependency degradation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a bounded 502 when ROVIQ Local is unreachable without falling through to Core mutation paths', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('local offline'));
    vi.stubGlobal('fetch', fetchSpy);

    const request = new Request('https://core.test/api/local/route?from=1,2&to=3,4', {
      method: 'GET',
      headers: { authorization: 'Bearer should-not-be-forwarded' }
    });
    const url = new URL(request.url);
    const response = await handleLocalCoreRequest(request, {}, url);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'local_upstream_unreachable' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const upstream = fetchSpy.mock.calls[0][0] as Request;
    expect(upstream.url).toBe('https://roviq-local2.admytruk79.workers.dev/api/route?from=1,2&to=3,4');
    expect(upstream.headers.get('authorization')).toBeNull();
    expect(upstream.headers.get('x-roviq-via')).toBe('core-local-adapter');
  });

  it('returns 503 when Workers AI is not bound and does not proxy the triage request elsewhere', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const request = new Request('https://core.test/api/triage/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-api-key': 'admin-test-key' },
      body: JSON.stringify({ caseId: '11111111-1111-4111-8111-111111111111', symptoms: 'vehicle will not start' })
    });

    const response = await worker.fetch(request, {
      ADMIN_API_KEY: 'admin-test-key',
      CORE_API_URL: 'https://authoritative-core.invalid'
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'workers_ai_not_bound' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pings Core\'s /health on every scheduled cron tick to keep Render\'s free tier from spinning down', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await pingCore({ CORE_API_URL: 'https://roviq-core.onrender.com' });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [pingedUrl] = fetchSpy.mock.calls[0] as [URL];
    expect(pingedUrl.toString()).toBe('https://roviq-core.onrender.com/health');
  });

  it('does not throw when the keep-warm ping to Core fails -- it must never break the deadline/notification sweep', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await pingCore({ CORE_API_URL: 'https://roviq-core.onrender.com' });

    expect(result).toEqual({ ok: false, reason: 'Failed to fetch' });
  });

  it('reports a clear reason when Core\'s URL is not configured, rather than throwing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await pingCore({});

    expect(result).toEqual({ ok: false, reason: 'core_api_not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows the cache-control request header in CORS preflight, matching what portal clients send', async () => {
    // tow/src/App.tsx's req() sends cache-control:no-cache on every request. A browser enforcing
    // CORS preflight blocks the whole request if a header it sends isn't in
    // access-control-allow-headers -- this was silently breaking every dispatches/history fetch in
    // a real browser (Node's fetch and curl don't enforce CORS, so it never surfaced in non-browser
    // testing) and is a real, live production bug independent of the migration-checksum outage.
    const preflight = await worker.fetch(new Request('https://core.test/api/transport/me/dispatches', {
      method: 'OPTIONS',
      headers: { origin: 'https://roviq-tow-net.pages.dev', 'access-control-request-headers': 'content-type,cache-control,authorization' }
    }), {});
    expect(preflight.status).toBe(204);
    const allowedHeaders = preflight.headers.get('access-control-allow-headers')?.split(',') ?? [];
    expect(allowedHeaders).toContain('cache-control');
  });

  it('keeps shadow and advisory AI assessments non-authoritative even when otherwise usable', () => {
    expect(evaluateAssessmentAuthority({
      deploymentMode: 'shadow', status: 'proposed', requiresHumanReview: false
    })).toEqual({ effectiveForAutomation: false, rationale: 'ai_shadow_observation_only' });

    expect(evaluateAssessmentAuthority({
      deploymentMode: 'advisory', status: 'accepted', requiresHumanReview: false
    })).toEqual({ effectiveForAutomation: false, rationale: 'ai_advisory_human_decision_required' });
  });

  it('blocks assisted AI from automation when deterministic safety or human review requires it', () => {
    expect(evaluateAssessmentAuthority({
      deploymentMode: 'assisted', status: 'accepted', requiresHumanReview: false, safetyOverride: true
    })).toEqual({ effectiveForAutomation: false, rationale: 'ai_safety_override_human_review_required' });

    expect(evaluateAssessmentAuthority({
      deploymentMode: 'assisted', status: 'accepted', requiresHumanReview: true
    })).toEqual({ effectiveForAutomation: false, rationale: 'ai_human_review_required' });
  });

  it('signs webhook deliveries with the exact HMAC-SHA256 hex digest subscribers verify against', async () => {
    // src/services/integration-gateway.ts's deliverWebhookBatch (the admin-triggered, non-Worker
    // delivery path) signs with node:crypto's createHmac -- a subscriber's signature check must
    // pass identically regardless of which path delivered the event, so this native Worker's
    // Web Crypto reimplementation has to produce byte-identical hex output for the same input.
    const expected = createHmac('sha256', 'whsec_test').update('123.{"a":1}').digest('hex');
    await expect(hmacSha256Hex('whsec_test', '123.{"a":1}')).resolves.toBe(expected);
  });

  it('delivers a claimed webhook, signs it, and marks it delivered on a 2xx response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const delivery = {
      id: 'delivery-1', subscription_id: 'sub-1', integration_event_id: 'event-1', attempt_count: 0,
      endpoint_url: 'https://partner.example/webhooks/roviq', secret: 'whsec_test',
      event_type: 'case.updated', aggregate_type: 'service_case', aggregate_id: 'case-1',
      actor_id: 'actor-1', payload: { state: 'repair_in_progress' }, occurred_at: '2026-09-05T00:00:00Z'
    };
    const { tag: sql, calls } = fakeSql([[delivery], []]);

    const results = await processWebhookOutboxNative(sql as never, 10);

    expect(results).toEqual([{ id: 'delivery-1', state: 'delivered' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(delivery.endpoint_url);
    expect(init.headers['x-roviq-event-id']).toBe('event-1');
    const ts = init.headers['x-roviq-timestamp'];
    expect(ts).toBeTruthy();
    const expectedSig = `v1=${createHmac('sha256', 'whsec_test').update(`${ts}.${init.body}`).digest('hex')}`;
    expect(init.headers['x-roviq-signature']).toBe(expectedSig);

    // Second sql call is the post-delivery write; confirm it marks the row delivered with the
    // real response code, and does not touch retry/backoff fields.
    expect(calls[1].text).toContain("state='delivered'");
    expect(calls[1].values).toEqual([200, 'delivery-1']);
  });

  it('retries a failing webhook delivery with exponential backoff instead of dropping it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const delivery = {
      id: 'delivery-2', subscription_id: 'sub-1', integration_event_id: 'event-2', attempt_count: 2,
      endpoint_url: 'https://partner.example/webhooks/roviq', secret: 'whsec_test',
      event_type: 'case.updated', aggregate_type: 'service_case', aggregate_id: 'case-2',
      actor_id: 'actor-1', payload: {}, occurred_at: '2026-09-05T00:00:00Z'
    };
    const { tag: sql, calls } = fakeSql([[delivery], []]);

    const results = await processWebhookOutboxNative(sql as never, 10);

    expect(results).toEqual([{ id: 'delivery-2', state: 'retry' }]);
    // attempt_count was 2, so this is attempt 3 of 8 -- not yet dead, backoff is 2^3*15=120s.
    expect(calls[1].values).toEqual(['retry', 3, 'http_500', '120', 'delivery-2']);
  });

  it('dead-letters a webhook delivery after 8 failed attempts instead of retrying forever', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const delivery = {
      id: 'delivery-3', subscription_id: 'sub-1', integration_event_id: 'event-3', attempt_count: 7,
      endpoint_url: 'https://partner.example/webhooks/roviq', secret: 'whsec_test',
      event_type: 'case.updated', aggregate_type: 'service_case', aggregate_id: 'case-3',
      actor_id: 'actor-1', payload: {}, occurred_at: '2026-09-05T00:00:00Z'
    };
    const { tag: sql, calls } = fakeSql([[delivery], []]);

    const results = await processWebhookOutboxNative(sql as never, 10);

    expect(results).toEqual([{ id: 'delivery-3', state: 'dead' }]);
    // attempt_count was 7, so this is attempt 8 -- the dead-letter threshold.
    expect(calls[1].values).toEqual(['dead', 8, 'http_500', '3600', 'delivery-3']);
  });
});
