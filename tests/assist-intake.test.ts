import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.js';
import { intakeTurn, safetyFlags, triageInputFromDemand } from '../cloudflare/assist.js';

// The customer intake conversation: the model's answer is shaped into a case draft, fixed safety
// rules override it, and if the model fails the customer can still send their own words.

const ai = (response: unknown) => ({ run: vi.fn().mockResolvedValue({ response: typeof response === 'string' ? response : JSON.stringify(response) }) });
const user = (content: string) => ({ role: 'user', content });

afterEach(() => vi.unstubAllGlobals());

describe('intake conversation', () => {
  it('turns the model answer into a draft the form can submit', async () => {
    const env = { AI: ai({ reply: 'Does it click when you turn the key?', draft: { issueType: 'wont_start', summary: 'Truck will not start since this morning.', likelyArea: 'battery or starter', drivable: 'no', urgency: 'urgent' }, ready: false }) };
    const result = await intakeTurn(env, [user('My truck won’t start')]);
    expect(result).toMatchObject({ status: 200, reply: 'Does it click when you turn the key?', ready: false, assistant: 'ai', safetyFlags: [] });
    expect(result.draft).toEqual({ issueType: 'wont_start', summary: 'Truck will not start since this morning.', likelyArea: 'battery or starter', drivable: 'no', urgency: 'urgent' });
    // The model sees a system prompt, then the conversation.
    expect(env.AI.run.mock.calls[0][1].messages[0].role).toBe('system');
  });

  it('accepts a model answer wrapped in prose or code fences and keeps values to the allowed lists', async () => {
    const env = { AI: ai('Sure!\n```json\n{"reply":"Got it.","draft":{"issueType":"engine_explosion","drivable":"maybe","urgency":"whenever"},"ready":true}\n```') };
    const result = await intakeTurn(env, [user('weird noise'), { role: 'assistant', content: 'What kind?' }, user('grinding when braking')]);
    expect(result.ready).toBe(true);
    expect(result.draft).toMatchObject({ issueType: 'other', drivable: 'unsure', urgency: 'normal' });
  });

  it('lets fixed safety rules override the model', async () => {
    const env = { AI: ai({ reply: 'Okay, when did it start?', draft: { issueType: 'other', summary: 'Smoke.', drivable: 'yes', urgency: 'normal' }, ready: false }) };
    const result = await intakeTurn(env, [user('There is smoke coming from under the hood')]);
    expect(result.safetyFlags).toContain('fire_or_smoke');
    expect(result.draft).toMatchObject({ drivable: 'no', urgency: 'emergency' });
    expect(result.reply).toMatch(/don’t drive/);
    expect(safetyFlags('my brake pedal goes to the floor')).toContain('brake_failure');
    expect(safetyFlags('it smells like gas')).toContain('fuel_leak');
    expect(safetyFlags('the AC is weak')).toEqual([]);
  });

  it('keeps going without the model, so the customer can still send their own words', async () => {
    const first = await intakeTurn({}, [user('Flat tire on the highway')]);
    expect(first).toMatchObject({ status: 200, assistant: 'fallback', ready: false });
    const failing = { AI: { run: vi.fn().mockRejectedValue(new Error('capacity')) } };
    const second = await intakeTurn(failing, [user('Flat tire'), { role: 'assistant', content: 'More?' }, user('Rear left, I have no spare')]);
    expect(second).toMatchObject({ assistant: 'fallback', ready: true });
    expect(second.draft.summary).toContain('Rear left, I have no spare');
  });

  it('rejects a conversation that does not end with the customer', async () => {
    expect(await intakeTurn({}, [])).toMatchObject({ status: 400, error: 'messages_invalid' });
    expect(await intakeTurn({}, [{ role: 'assistant', content: 'Hi' }])).toMatchObject({ status: 400 });
    expect(await intakeTurn({}, 'nope')).toMatchObject({ status: 400 });
  });
});

describe('Worker intake endpoint', () => {
  const call = (headers: Record<string, string> = {}) => worker.fetch(new Request('https://core.test/api/assist/intake', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ messages: [user('Battery light is on')] })
  }), { CORE_API_URL: 'https://core.invalid', AI: ai({ reply: 'Is the car still running?', draft: { issueType: 'battery' }, ready: false }) }, { waitUntil: vi.fn() });

  it('is for signed-in customers only, checked with Core', async () => {
    expect((await call()).status).toBe(401);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ active: { role: 'tow' } }), { status: 200 })));
    expect((await call({ authorization: 'Bearer tow-token' })).status).toBe(401);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ active: { role: 'customer' } }), { status: 200 })));
    const ok = await call({ authorization: 'Bearer customer-token' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ reply: 'Is the car still running?', draft: { issueType: 'battery' } });
  });
});

describe('automatic first read on every new case', () => {
  it('builds the triage input from the customer request and the created case', () => {
    expect(triageInputFromDemand(
      { demandType: 'wont_start', urgency: 'urgent', attributes: { description: 'Clicks when I turn the key.' }, vehicle: { make: 'Ford' } },
      { case: { id: 'case-1' } }
    )).toEqual({ caseId: 'case-1', symptoms: 'Reported issue: wont start. Clicks when I turn the key.', vehicle: { make: 'Ford' }, observations: { urgency: 'urgent' } });
    expect(triageInputFromDemand({ demandType: 'x' }, { error: 'bad' })).toBeNull();
  });

  it('schedules the read after Core creates the case, without delaying the customer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ case: { id: '11111111-1111-4111-8111-111111111111' } }), { status: 201, headers: { 'content-type': 'application/json' } })));
    const waitUntil = vi.fn();
    const response = await worker.fetch(new Request('https://core.test/api/demands', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer c' },
      body: JSON.stringify({ domain: 'maintenance', demandType: 'battery', attributes: { description: 'Battery light on' } })
    }), { CORE_API_URL: 'https://core.invalid', AI: ai({}) }, { waitUntil });
    expect(response.status).toBe(201);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    // The promise is swallowed on failure (no database here), never surfacing to the customer.
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it('does not run on a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'vehicle_required' }), { status: 400 })));
    const waitUntil = vi.fn();
    await worker.fetch(new Request('https://core.test/api/demands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"demandType":"battery"}' }), { CORE_API_URL: 'https://core.invalid', AI: ai({}) }, { waitUntil });
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
