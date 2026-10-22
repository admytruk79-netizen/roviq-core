import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Exercise the real Customer API client at its fetch boundary without a Vite runtime.
const source = (await readFile(new URL('../web/src/lib/api.ts', import.meta.url), 'utf8'))
  .replace("import.meta.env.VITE_API_BASE_URL ?? ''", "''");
const { api } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);

test('bodyless actions omit JSON content type; payload requests retain JSON and authentication', async () => {
  const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  const requests = [];
  globalThis.localStorage = { getItem: () => 'fixture-token', removeItem: () => {} };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    // Fastify rejects an empty body declared as application/json before reaching the handler.
    if (options.body === undefined && options.headers.has('Content-Type')) return Response.json({ error: 'FST_ERR_CTP_EMPTY_JSON_BODY' }, { status: 400 });
    return Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await api.post('/api/me/vehicles/fixture/reminders/fixture/complete'), { ok: true });
    assert.equal(requests[0].options.headers.has('Content-Type'), false);
    assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer fixture-token');
    await api.patch('/api/me/vehicles/fixture', { odometerValue: 100 });
    assert.equal(requests[1].options.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(requests[1].options.body), { odometerValue: 100 });
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.localStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous.localStorage;
  }
});
