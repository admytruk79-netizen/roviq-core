import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const code = await readFile(new URL('../cloudflare/obd-scan.js', import.meta.url), 'utf8');
const obd = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('stored DTC responses preserve exact code identities', () => {
  assert.deepEqual(obd.decodeStoredDtcs('03\r43 01 33 03 02 00 00\r>'), ['P0133', 'P0302']);
  assert.deepEqual(obd.decodeStoredDtcs('43 02 01 33 03 02\r>'), ['P0133', 'P0302']);
  assert.deepEqual(obd.decodeStoredDtcs('43 00 00\r>'), []);
});
test('no-data, partial and unsupported frames are failures, never healthy scans', () => {
  for (const raw of ['NO DATA\r>', '43 01', '7E8 06 43 01 33 00 00\r>', '43 02 01 33\r>']) assert.throws(() => obd.decodeStoredDtcs(raw));
});
test('read-only allowlist denies clear-code, actuator and arbitrary commands', () => {
  for (const command of ['04', '08', 'ATSH7E0', '03\r04', '010C\r']) assert.throws(() => obd.allowedObdCommand(command));
  assert.equal(obd.allowedObdCommand('03'), '03\r');
});
test('measurements decode with units; multiple ECU values are not silently merged', () => {
  assert.deepEqual(obd.decodePid('41 0C 1A F8\r>', '0C'), { engineRpm: 1726 });
  assert.deepEqual(obd.decodePid('41 05 7B\r>', '05'), { coolantTemperatureC: 83 });
  assert.deepEqual(obd.decodePid('41 0D 28\r>', '0D'), { vehicleSpeedKmh: 40 });
  assert.throws(() => obd.decodePid('41 0C 1A F8\r41 0C 1B F8\r>', '0C'));
});
test('scan event keeps stable retry identity, vehicle binding and review requirement', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const context = { vehicleId: id, sourceId: id, enrollmentId: id, serviceCaseId: id };
  const scan = { scanId: 'stable-scan-id', observedAt: '2026-10-12T00:00:00Z', dtcResponse: '43 03 02\r>' };
  const event = obd.createHealthEvent(context, scan);
  assert.deepEqual(event, obd.createHealthEvent(context, scan));
  assert.deepEqual(event.dtcCodes, ['P0302']);
  assert.equal(event.safetyState, 'review_required');
  assert.throws(() => obd.createHealthEvent({}, scan));
});

test('authenticated ingestion precedes analysis; analysis is requested by persisted event identity', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    return new Response(JSON.stringify(calls.length === 1 ? { event: { id: 'event-1' } } : { analysisPending: false, job: {state: 'completed_ai', assessment_id: 'assessment-1',result: {modelStatus:'ai',summary:'Recorded scanner evidence requires review'}} }));
  };
  const result = await obd.uploadAndAnalyzeScan({ token: 'test-token', apiBase: 'https://roviq-core.admytruk79.workers.dev',
    context: { vehicleId: id, sourceId: id, enrollmentId: id, serviceCaseId: id },
    scan: { scanId: 'scan-1', observedAt: '2026-10-12T00:00:00Z', dtcResponse: '43 03 02\r>' } });
  assert.ok(calls[0].url.endsWith('/api/connected/health-events'));
  assert.equal(calls[0].auth, 'Bearer test-token');
  assert.deepEqual(calls[0].body.dtcCodes, ['P0302']);
  assert.equal(calls[1].body.eventId, 'event-1');
  assert.equal(calls[1].body.dtcCodes, undefined);
  assert.equal(result.analysisPending, false);
});
test('rejected ingestion never invokes analysis', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 403 }); };
  await assert.rejects(obd.uploadAndAnalyzeScan({ token: 'test-token', apiBase: 'https://roviq-core.admytruk79.workers.dev',
    context: { vehicleId: id, sourceId: id, enrollmentId: id, serviceCaseId: id },
    scan: { scanId: 'scan-1', observedAt: '2026-10-12T00:00:00Z', dtcResponse: '43 00 00\r>' } }), /obd_ingestion_rejected_403/);
  assert.equal(calls, 1);
});
