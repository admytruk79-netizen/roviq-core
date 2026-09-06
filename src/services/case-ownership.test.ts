import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCaseOwnership } from './case-ownership.js';

test('customer owns intake',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'intake',customerActorId:'customer-1'}),{role:'customer',actorId:'customer-1'});
});

test('diagnostic states project to diagnostic role',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'diagnostic_pending'}),{role:'diagnostic',actorId:null});
  assert.deepEqual(deriveCaseOwnership({state:'diagnostic_in_progress'}),{role:'diagnostic',actorId:null});
});

test('tow states project to tow role',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'tow_pending'}),{role:'tow',actorId:null});
  assert.deepEqual(deriveCaseOwnership({state:'tow_in_progress'}),{role:'tow',actorId:null});
});

test('selected provider owns provider and repair states',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'provider_pending',selectedActorId:'shop-1'}),{role:'partner',actorId:'shop-1'});
  assert.deepEqual(deriveCaseOwnership({state:'repair_in_progress',selectedActorId:'shop-1'}),{role:'partner',actorId:'shop-1'});
});

test('parts owns parts pending and terminal cases have no owner',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'parts_pending'}),{role:'parts',actorId:null});
  assert.deepEqual(deriveCaseOwnership({state:'completed',selectedActorId:'shop-1'}),{role:null,actorId:null});
  assert.deepEqual(deriveCaseOwnership({state:'cancelled',customerActorId:'customer-1'}),{role:null,actorId:null});
});
