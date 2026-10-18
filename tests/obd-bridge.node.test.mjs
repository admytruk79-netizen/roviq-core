import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const code = await readFile(new URL('../cloudflare/obd-bridge-client.js', import.meta.url), 'utf8');
const {createObdBridgeClient} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function setup(options) {
  const sent = [];
  const bridge = {onmessage: null, postMessage(raw) {sent.push(JSON.parse(raw));}};
  const client = createObdBridgeClient(bridge, options);
  return {sent, bridge, client, reply(body) {bridge.onmessage?.({data: JSON.stringify(body)});}};
}
test('scanner responses are correlated to the exact request', async () => {
  const f = setup(); const pending = f.client.request('list');
  f.reply({id: 'wrong', devices: []});
  f.reply({id: f.sent[0].id, devices: [{name: 'OBDLink', address: 'paired'}]});
  assert.equal((await pending).devices.length, 1); f.client.dispose();
});
test('cancel rejects pending scan and late success cannot revive it', async () => {
  const f = setup(); const pending = f.client.request('scan', 'paired');
  const assertion = assert.rejects(pending, /scanner_cancelled/);
  f.client.cancel(); f.reply({id: f.sent[0].id, snapshot: {}});
  await assertion; assert.equal(f.sent[1].action, 'cancel'); f.client.dispose();
});
test('timeout cancels the native scan', async () => {
  const f = setup({timeoutMs: 5});
  await assert.rejects(f.client.request('scan', 'paired'), /scanner_timeout/);
  assert.equal(f.sent[1].action, 'cancel'); f.client.dispose();
});
test('disposed bridge and arbitrary commands are rejected', async () => {
  const f = setup(); await assert.rejects(f.client.request('04'), /scanner_action_not_allowed/);
  f.client.dispose(); await assert.rejects(f.client.request('scan'), /scanner_client_closed/);
  assert.equal(f.bridge.onmessage, null);
});
test('permission error is surfaced without an inferred successful scan', async () => {
  const f = setup(); const pending = f.client.request('list');
  f.reply({id: f.sent[0].id, error: 'bluetooth_permission_required'});
  await assert.rejects(pending, /bluetooth_permission_required/); f.client.dispose();
});
