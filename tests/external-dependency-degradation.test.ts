import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.js';
import { handleLocalCoreRequest } from '../cloudflare/local-adapter.js';
import { evaluateAssessmentAuthority } from '../src/services/ai-authority.js';

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
    const response = await handleLocalCoreRequest(request, { ROVIQ_LOCAL_API_URL: 'https://local.invalid' }, url);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'local_upstream_unreachable' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const upstream = fetchSpy.mock.calls[0][0] as Request;
    expect(upstream.url).toBe('https://local.invalid/api/route?from=1,2&to=3,4');
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
});
