import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Exercise the original orchestration functions with an injected database.
// Remove the default pool import; all database tests supply their own queryable.
const source = (await readFile(new URL('../src/services/network-execution.ts', import.meta.url), 'utf8'))
  .replace("import { pool } from '../db/pool.js';", '');
const code = stripTypeScriptTypes(source, { mode: 'transform' });
const core = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function database(plan, constraints = [], handoffs = []) {
  const writes = [];
  return { writes, async query(sql, params) {
    if (sql.includes('select * from fulfillment_plans')) return { rows: plan ? [plan] : [] };
    if (sql.includes('from case_constraints')) return { rows: constraints };
    if (sql.includes('from network_handoffs')) return { rows: handoffs };
    writes.push({ sql, params });
    return { rows: [{ id: 'outcome' }] };
  } };
}

test('tow, parts and mobility progress map into the shared case lifecycle', () => {
  assert.equal(core.handoffStatusForTransport('in_transit'), 'in_progress');
  assert.equal(core.handoffStatusForTransport('delivered'), 'completed');
  assert.equal(core.handoffStatusForParts('shipped'), 'in_progress');
  assert.equal(core.handoffStatusForParts('delivered'), 'completed');
  assert.equal(core.handoffStatusForMobility('return_pending'), 'in_progress');
  assert.equal(core.handoffStatusForMobility('completed'), 'completed');
});
test('repair completion cannot bypass undelivered parts or unfinished tow', async () => {
  const db = database({ id: 'plan', status: 'accepted' }, [], [
    { handoff_type: 'parts', status: 'in_progress' },
    { handoff_type: 'transport', status: 'accepted' },
    { handoff_type: 'service_provider', status: 'completed' }
  ]);
  const result = await core.evaluateFulfillmentCompletion('case', db);
  assert.equal(result.ready, false);
  assert.equal(result.blockers.length, 2);
  await assert.rejects(core.recordCompletionOutcome({ caseId: 'case' }, db), /fulfillment_not_complete/);
  assert.equal(db.writes.length, 0);
});
test('warranty and customer authorization constraints block completion', async () => {
  const db = database({ id: 'plan', status: 'accepted' }, [
    { constraint_type: 'warranty', status: 'pending' },
    { constraint_type: 'customer_approval', status: 'pending' }
  ], [{ handoff_type: 'service_provider', status: 'completed' }]);
  assert.equal((await core.evaluateFulfillmentCompletion('case', db)).ready, false);
});
test('failed provider handoff remains a blocker', async () => {
  const db = database({ id: 'plan', status: 'accepted' }, [], [{ handoff_type: 'service_provider', status: 'failed' }]);
  await assert.rejects(core.recordCompletionOutcome({ caseId: 'case' }, db), /fulfillment_not_complete/);
  assert.equal(db.writes.length, 0);
});
test('a plan awaiting acceptance cannot complete even with no remaining dependencies', async () => {
  const db = database({ id: 'plan', status: 'proposed' });
  assert.equal((await core.evaluateFulfillmentCompletion('case', db)).ready, false);
});
test('accepted plan with fulfilled dependencies records the shared completion snapshot', async () => {
  const db = database({ id: 'plan', status: 'accepted' }, [{ constraint_type: 'warranty', status: 'satisfied' }], [
    { handoff_type: 'parts', status: 'completed' },
    { handoff_type: 'transport', status: 'completed' },
    { handoff_type: 'service_provider', status: 'completed' }
  ]);
  assert.equal((await core.evaluateFulfillmentCompletion('case', db)).ready, true);
  await core.recordCompletionOutcome({ caseId: 'case' }, db);
  assert.equal(db.writes.length, 2);
  const snapshot = JSON.parse(db.writes[0].params[2]);
  assert.equal(snapshot.handoffs.length, 3);
});
test('a missing plan cannot bypass recorded warranty and handoff dependencies', async () => {
  const db = database(null, [{ constraint_type: 'warranty', status: 'pending' }]);
  assert.equal((await core.evaluateFulfillmentCompletion('case', db)).ready, false);
  await assert.rejects(core.recordCompletionOutcome({caseId:'case'},db),/fulfillment_not_complete/);
  assert.equal(db.writes.length,0);
  const unfinished = database(null, [], [{handoff_type:'transport',status:'in_progress'}]);
  await assert.rejects(core.recordCompletionOutcome({caseId:'case'},unfinished),/fulfillment_not_complete/);
  assert.equal(unfinished.writes.length,0);
});
test('a legacy completion retains its checked dependencies and explicit verification mode', async () => {
  const db = database(null,[{constraint_type:'authorization',status:'satisfied'}],[{handoff_type:'transport',status:'completed'}]);
  const result=await core.evaluateFulfillmentCompletion('case',db);
  assert.equal(result.ready,true);
  assert.equal(result.verificationMode,'legacy_dependency_check');
  await core.recordCompletionOutcome({caseId:'case'},db);
  const snapshot=JSON.parse(db.writes[0].params[2]);
  assert.equal(snapshot.verificationMode,'legacy_dependency_check');
  assert.equal(snapshot.constraints.length,1);
  assert.equal(snapshot.handoffs.length,1);
});
