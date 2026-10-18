import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
const source = await readFile(new URL('../src/services/obd-access-policy.ts', import.meta.url), 'utf8');
const policy = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, {mode: 'transform'})).toString('base64')}`);
const actor = {role: 'diagnostic', actorId: 'diagnostic-1'};
const record = {vehicle_id: 'vehicle-1', customer_actor_id: 'customer-1', current_owner_actor_id: 'diagnostic-1', state: 'diagnostic_pending'};
const consent = {enrollment_status: 'active', consent_status: 'active', customer_actor_id: 'customer-1', retention_until: null, scopes: ['vehicle_health']};

test('assigned diagnostic and selected shop can scan the case vehicle', () => {
  policy.assertTechnicianScanCase(actor, 'vehicle-1', record);
  policy.assertTechnicianScanCase({role: 'partner', actorId: 'shop-1'}, 'vehicle-1', {...record, selected_actor_id: 'shop-1'});
  policy.assertScanConsent(record, consent);
});
test('unrelated actors and incorrect vehicles fail closed', () => {
  assert.throws(() => policy.assertTechnicianScanCase({...actor, actorId: 'outsider'}, 'vehicle-1', record), /scan_assignment_required/);
  assert.throws(() => policy.assertTechnicianScanCase(actor, 'vehicle-2', record), /case_vehicle_mismatch/);
});
test('terminal cases, unsupported roles and missing actor bindings are denied', () => {
  for (const state of ['completed', 'cancelled']) assert.throws(() => policy.assertTechnicianScanCase(actor, 'vehicle-1', {...record, state}), /case_closed/);
  for (const principal of [{role: 'tow', actorId: 'diagnostic-1'}, {role: 'diagnostic'}]) assert.throws(() => policy.assertTechnicianScanCase(principal, 'vehicle-1', record), /forbidden/);
});
test('another customer’s consent cannot authorize this vehicle case', () => {
  assert.throws(() => policy.assertScanConsent(record, {...consent, customer_actor_id: 'customer-2'}), /scan_consent_customer_mismatch/);
});
test('revoked enrollment, revoked consent and missing scope deny ingestion', () => {
  for (const change of [{enrollment_status: 'revoked'}, {consent_status: 'revoked'}, {scopes: []}]) assert.throws(() => policy.assertScanConsent(record, {...consent, ...change}));
});
test('expired and malformed consent deadlines are rejected', () => {
  for (const retention_until of ['2020-01-01T00:00:00Z', 'invalid']) assert.throws(() => policy.assertScanConsent(record, {...consent, retention_until}), /scan_consent_expired/);
});
