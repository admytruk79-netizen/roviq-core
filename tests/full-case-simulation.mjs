import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

async function loadCore(file) {
  const source = (await readFile(new URL(`../src/services/${file}`, import.meta.url), 'utf8'))
    .replace("import { pool } from '../db/pool.js';", '');
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64')}`);
}
const core = await loadCore('network-execution.ts');
const capacity = await loadCore('capacity-reservation.ts');
const transcript = [];
const results = [];
function log(stage, detail) { transcript.push({ stage, detail }); }

// A deliberately narrow in-memory SQL boundary. Unknown queries fail loudly.
// It does NOT emulate PostgreSQL locking, isolation, constraints or durability.
function fixture() {
  const state = {
    plan: { id: 'plan-1', service_case_id: 'case-1', status: 'feasible', recovery_required_at: null },
    constraints: [
      { constraint_type: 'customer_approval', status: 'pending' },
      { constraint_type: 'warranty', status: 'satisfied' }
    ],
    candidate: { id: 'candidate-1', actor_id: 'shop-1', participant_status: 'proposed' },
    acceptance: null, handoffs: [], outcome: null, holds: [],
    resource: { id: 'bay-1', active: true, operational_state: 'available' },
    window: { id: 'window-1', resource_id: 'bay-1', capacity_units: 1,
      capacity_state: 'available', sync_state: 'current', connection_status: 'active',
      window_start: new Date(Date.now() - 60_000), window_end: new Date(Date.now() + 3_600_000) }
  };
  const rows = list => ({ rows: structuredClone(list), rowCount: list.length });
  return { state, async query(raw, p = []) {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('select * from fulfillment_plans')) return rows(state.plan ? [state.plan] : []);
    if (sql.startsWith('select * from fulfillment_candidates')) return rows(p[1] === state.candidate.actor_id ? [state.candidate] : []);
    if (sql.startsWith('insert into participant_acceptances')) {
      state.acceptance = { actor_id: p[3], decision: p[4] }; return rows([state.acceptance]);
    }
    if (sql.startsWith('update fulfillment_candidates')) {
      if (sql.includes('set participant_status=$1')) state.candidate.participant_status = p[0];
      return rows([]);
    }
    if (sql.startsWith('select status,recovery_required_at')) return rows([state.plan]);
    if (sql.startsWith('select count(*)::int as total')) return rows([{ total: state.constraints.filter(c => !['satisfied', 'waived'].includes(c.status)).length }]);
    if (sql.startsWith('update fulfillment_plans')) {
      if (sql.includes("status='completed'")) Object.assign(state.plan, { status: 'completed', recovery_required_at: null });
      else if (sql.includes("status='cancelled'")) state.plan.status = 'cancelled';
      else if (sql.includes('set status=$2')) Object.assign(state.plan, { status: p[1], selected_actor_id: p[2] });
      else if (sql.includes("recovery_reason='participant_declined'")) Object.assign(state.plan, { status: 'blocked', recovery_required_at: new Date(), recovery_reason: 'participant_declined' });
      else Object.assign(state.plan, { status: 'blocked', recovery_required_at: new Date(), recovery_reason: p[1] });
      return rows([state.plan]);
    }
    if (sql.startsWith('insert into network_handoffs')) {
      const prior = state.handoffs.find(h => h.handoff_type === p[2] && h.reference_type === p[4] && h.reference_id === p[5]);
      const next = { service_case_id: p[0], fulfillment_plan_id: prior?.fulfillment_plan_id ?? p[1], handoff_type: p[2], participant_actor_id: p[3], reference_type: p[4], reference_id: p[5], status: p[6] };
      if (prior) Object.assign(prior, next); else state.handoffs.push(next);
      return rows([next]);
    }
    if (sql.startsWith('select actor_id from participant_acceptances')) return rows(state.acceptance?.decision === 'accepted' ? [state.acceptance] : []);
    if (sql.includes('from case_constraints')) return rows(state.constraints);
    if (sql.includes('from network_handoffs')) return rows(state.handoffs.filter(h => h.fulfillment_plan_id === p[0]));
    if (sql.startsWith('insert into completion_outcomes')) {
      state.outcome = { outcome: sql.includes("'cancelled'") ? 'cancelled' : 'completed', snapshot: JSON.parse(p[2]) };
      return rows([state.outcome]);
    }
    if (sql.startsWith('update network_handoffs')) {
      state.handoffs.filter(h => h.handoff_type === 'service_provider').forEach(h => { h.status = 'completed'; }); return rows(state.handoffs);
    }
    if (sql.startsWith('select resource_id from capacity_windows')) return rows([{ resource_id: state.window.resource_id }]);
    if (sql.includes('from service_resources')) return rows([state.resource]);
    if (sql.includes('from capacity_windows cw')) return rows([state.window]);
    if (sql.startsWith('select id,units from capacity_reservations')) return rows(state.holds.filter(h => h.caseId === p[0] && h.state === 'held'));
    if (sql.startsWith('select coalesce(sum(units)')) return rows([{ units: state.holds.filter(h => h.state === 'held').reduce((n, h) => n + h.units, 0) }]);
    if (sql.startsWith('insert into capacity_reservations')) { state.holds.push({ caseId: p[0], units: p[2], state: 'held' }); return rows([]); }
    if (sql.startsWith('update capacity_reservations')) {
      if (sql.includes("set state='released'")) state.holds.filter(h => h.caseId === p[0]).forEach(h => { h.state = 'released'; });
      if (sql.includes("set state='consumed'")) state.holds.filter(h => h.caseId === p[0]).forEach(h => { h.state = 'consumed'; });
      return rows([]);
    }
    throw new Error(`Unimplemented database operation: ${sql}`);
  } };
}

function handoff(db, type, status) {
  return core.upsertNetworkHandoff({ caseId: 'case-1', handoffType: type, status,
    participantActorId: `${type}-actor`, referenceType: type, referenceId: `${type}-job` }, db);
}
function decision(db, value = 'accepted') {
  return core.syncFulfillmentParticipantDecision({ caseId: 'case-1', actorId: 'shop-1', decision: value, sourceType: 'simulation' }, db);
}
async function scenario(name, fn) {
  test(name, async () => {
    try { await fn(); results.push({ name, result: 'passed' }); }
    catch (error) { results.push({ name, result: 'failed', error: error.message }); throw error; }
  });
}

await scenario('full case: diagnostic → tow → shop approval → parts → repair → completion', async () => {
  const db = fixture();
  log('Customer intake', 'Mock customer/vehicle/case and proposed plan created; HTTP intake is outside this harness.');
  await handoff(db, 'diagnostic', 'assigned');
  await handoff(db, 'diagnostic', 'completed');
  log('Diagnostics', 'Core persisted assigned/completed handoff for the same case.');
  await capacity.reserveCanonicalCapacity('case-1', 'window-1', db, 1, new Date());
  await decision(db);
  assert.equal(db.state.plan.status, 'blocked');
  log('Shop acceptance', 'Accepted provider remains blocked until customer approval is satisfied.');
  await handoff(db, 'service_provider', 'accepted');
  await handoff(db, 'transport', core.handoffStatusForTransport('in_transit'));
  await assert.rejects(core.recordCompletionOutcome({ caseId: 'case-1' }, db), /fulfillment_not_complete/);
  await handoff(db, 'transport', core.handoffStatusForTransport('delivered'));
  log('Tow', 'Tow delivered to the chosen shop; premature case completion was rejected.');
  db.state.constraints.find(c => c.constraint_type === 'customer_approval').status = 'satisfied';
  await handoff(db, 'service_provider', 'in_progress');
  assert.equal(db.state.plan.status, 'accepted');
  await handoff(db, 'parts', core.handoffStatusForParts('shipped'));
  await assert.rejects(core.recordCompletionOutcome({ caseId: 'case-1' }, db), /fulfillment_not_complete/);
  await handoff(db, 'parts', core.handoffStatusForParts('delivered'));
  log('Approval and parts', 'Mock approval resolved; Core blocked completion while parts were in transit.');
  await core.markServiceProviderWorkCompleted('case-1', db);
  assert.equal((await core.evaluateFulfillmentCompletion('case-1', db)).ready, true);
  await core.recordCompletionOutcome({ caseId: 'case-1', evidence: { simulated: true } }, db);
  await capacity.consumeCaseCapacity('case-1', db);
  assert.equal(db.state.plan.status, 'completed');
  assert.equal(db.state.outcome.snapshot.handoffs.length, 4);
  assert.equal(db.state.holds[0].state, 'consumed');
  log('Completion', 'Core recorded the diagnostic, tow, parts, and shop snapshot; capacity consumed. Payment is not simulated as a real charge.');
});

await scenario('repeated reservation and handoff requests do not duplicate logical records', async () => {
  const db = fixture();
  await capacity.reserveCanonicalCapacity('case-1', 'window-1', db, 1, new Date());
  await capacity.reserveCanonicalCapacity('case-1', 'window-1', db, 1, new Date());
  assert.equal(db.state.holds.length, 1);
  await handoff(db, 'transport', 'assigned');
  await handoff(db, 'transport', 'assigned');
  assert.equal(db.state.handoffs.length, 1);
});
await scenario('unavailable bay, stale connection and exhausted capacity reject booking', async () => {
  for (const failure of ['bay', 'sync', 'connection', 'full']) {
    const db = fixture();
    if (failure === 'bay') db.state.resource.operational_state = 'offline';
    if (failure === 'sync') db.state.window.sync_state = 'stale';
    if (failure === 'connection') db.state.window.connection_status = 'paused';
    if (failure === 'full') db.state.window.capacity_units = 0;
    await assert.rejects(capacity.reserveCanonicalCapacity('case-1', 'window-1', db, 1, new Date()), /capacity_no_longer_available/);
    assert.equal(db.state.holds.length, 0);
  }
});
await scenario('second case cannot take the only held unit; cancellation releases it', async () => {
  const db = fixture();
  await capacity.reserveCanonicalCapacity('case-1', 'window-1', db, 1, new Date());
  await assert.rejects(capacity.reserveCanonicalCapacity('case-2', 'window-1', db, 1, new Date()), /capacity_no_longer_available/);
  await capacity.releaseCaseCapacity('case-1', db);
  await core.recordCancellationOutcome({ caseId: 'case-1', evidence: { simulated: true } }, db);
  assert.equal(db.state.plan.status, 'cancelled');
  await capacity.reserveCanonicalCapacity('case-2', 'window-1', db, 1, new Date());
  assert.equal(db.state.holds.filter(h => h.state === 'held').length, 1);
});
await scenario('provider decline and tow failure require explicit recovery', async () => {
  const declined = fixture();
  await decision(declined, 'declined');
  assert.equal(declined.state.plan.recovery_reason, 'participant_declined');
  const db = fixture();
  db.state.constraints.forEach(c => { c.status = 'satisfied'; });
  await decision(db);
  await handoff(db, 'transport', 'failed');
  assert.equal(db.state.plan.status, 'blocked');
  // A later success is insufficient to silently clear the recovery latch.
  await handoff(db, 'transport', 'completed');
  assert.equal(db.state.plan.status, 'blocked');
  await assert.rejects(core.recordCompletionOutcome({ caseId: 'case-1' }, db), /fulfillment_not_complete/);
});
await scenario('mobility must finish before the coordinated case completes', async () => {
  const db = fixture();
  db.state.constraints.forEach(c => { c.status = 'satisfied'; });
  await decision(db);
  await handoff(db, 'mobility', core.handoffStatusForMobility('return_pending'));
  assert.equal((await core.evaluateFulfillmentCompletion('case-1', db)).ready, false);
  await handoff(db, 'mobility', core.handoffStatusForMobility('completed'));
  assert.equal((await core.evaluateFulfillmentCompletion('case-1', db)).ready, true);
});

process.on('beforeExit', async () => {
  if (process.env.ROVIQ_SIM_REPORT_WRITTEN) return;
  process.env.ROVIQ_SIM_REPORT_WRITTEN = 'true';
  const dir = new URL('../artifacts/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('full-case-simulation.json', dir), JSON.stringify({
    generatedAt: new Date().toISOString(), sourceRevision: 'db76017b33c9846eac3a0344fa75e69fa07ae6e8',
    boundary: 'Real network execution and reservation functions; mocked SQL, intake, approval and external services. No HTTP, PostgreSQL concurrency, real payment or external delivery proof.',
    results, transcript
  }, null, 2));
});
