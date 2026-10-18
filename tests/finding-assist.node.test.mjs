import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const code = await readFile(new URL('../cloudflare/finding-assist.js', import.meta.url), 'utf8');
const { findingDraft, findingTurn } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const demandId = '11111111-1111-4111-8111-111111111111';
function request(notes = 'P0302 observed. Rough idle; cause not confirmed.') {
  return new Request('https://mock.invalid/api/assist/finding', { method: 'POST', headers: { authorization: 'Bearer mock-token', 'content-type': 'application/json' }, body: JSON.stringify({ demandId, notes }) });
}
test('AI draft preserves original evidence and codes; confirmation is mandatory', async () => {
  const notes = 'P0302 observed. Rough idle; cause not confirmed.';
  const result = await findingDraft({ AI: { run: async () => ({ response: JSON.stringify({ summary: 'Cylinder 2 misfire code reported; cause unconfirmed.', missingInformation: ['What tests were performed?'] }) }) } }, notes);
  assert.equal(result.assistant, 'ai');
  assert.equal(result.originalNotes, notes);
  assert.deepEqual(result.dtcCodes, ['P0302']);
  assert.equal(result.requiresTechnicianConfirmation, true);
  assert.equal(result.drivability, undefined);
  assert.equal(result.disposition, undefined);
});
test('unavailable or malformed AI preserves raw notes without inventing a finding', async () => {
  for (const env of [{}, { AI: { run: async () => ({ response: 'not json' }) } }]) {
    const result = await findingDraft(env, 'Battery voltage 11.2 V; starter not tested.');
    assert.equal(result.assistant, 'fallback');
    assert.equal(result.summary, result.originalNotes);
  }
});
test('stalled cloud drafting returns original notes after a bounded deadline', async () => {
  const notes='P0302 observed; ignition has not been tested.';
  const result=await findingDraft({AI:{run:()=>new Promise(()=>{})}},notes,5);
  assert.equal(result.assistant,'fallback');assert.equal(result.summary,notes);
});
test('invalid or oversized notes are rejected before cloud inference', async () => {
  let calls = 0;
  const env = { AI: { run: async () => { calls++; } } };
  assert.equal((await findingDraft(env, 'x')).status, 400);
  assert.equal((await findingDraft(env, 'x'.repeat(5001))).status, 400);
  assert.equal(calls, 0);
});
test('unassigned or merely offered jobs cannot invoke inference', async () => {
  let calls = 0;
  const env = { CORE_API_URL: 'https://core.invalid', AI: { run: async () => { calls++; } } };
  for (const queue of [[], [{ demand_id: demandId, outcome: 'offered' }]]) {
    globalThis.fetch = async url => new Response(JSON.stringify(String(url).endsWith('/roles') ? { active: { role: 'diagnostic', actorId: 'actor' } } : { queue }), { status: 200 });
    assert.equal((await findingTurn(request(), env)).status, 403);
  }
  assert.equal(calls, 0);
});
test('wrong role is denied and accepted diagnostic job can draft without mutation', async () => {
  const calls = [];
  const env = { CORE_API_URL: 'https://core.invalid' };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify({ active: { role: 'customer', actorId: 'actor' } }));
  };
  assert.equal((await findingTurn(request(), env)).status, 403);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify(String(url).endsWith('/roles') ? { active: { role: 'diagnostic', actorId: 'actor' } } : { queue: [{ demand_id: demandId, outcome: 'accepted' }] }));
  };
  assert.equal((await findingTurn(request(), env)).status, 200);
  assert.ok(calls.every(c => c.method === 'GET'));
});
test('Core outage fails closed before AI receives observations', async () => {
  let calls = 0;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const result = await findingTurn(request(), { CORE_API_URL: 'https://core.invalid', AI: { run: async () => { calls++; } } });
  assert.equal(result.status, 502);
  assert.equal(calls, 0);
});
