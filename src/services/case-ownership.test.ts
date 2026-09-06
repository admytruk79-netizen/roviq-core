import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCaseOwnership } from './case-ownership.js';

test('customer owns intake',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'intake',customerActorId:'customer-1'}),{role:'customer',actorId:'customer-1'});
});

test('entering diagnostic work clears stale actor ownership',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'diagnostic_pending',currentOwnerRole:'admin',currentOwnerActorId:'admin-1'}),{role:'diagnostic',actorId:null});
});

test('assigned diagnostic remains owner while diagnostic work advances',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'diagnostic_in_progress',currentOwnerRole:'diagnostic',currentOwnerActorId:'diagnostic-1'}),{role:'diagnostic',actorId:'diagnostic-1'});
});

test('entering tow work clears stale actor ownership',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'tow_pending',currentOwnerRole:'diagnostic',currentOwnerActorId:'diagnostic-1'}),{role:'tow',actorId:null});
});

test('assigned tow provider remains owner while tow work advances',()=>{
  assert.deepEqual(deriveCaseOwnership({state:'tow_in_progress',currentOwnerRole:'tow',currentOwnerActorId:'tow-1'}),{role:'tow',actorId:'tow-1'});
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
