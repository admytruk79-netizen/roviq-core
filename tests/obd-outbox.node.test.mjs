import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const scan=await readFile(new URL('../cloudflare/obd-scan.js',import.meta.url),'utf8');
const scanUrl=`data:text/javascript;base64,${Buffer.from(scan).toString('base64')}`;
const source=(await readFile(new URL('../cloudflare/obd-outbox.js',import.meta.url),'utf8')).replace("'./obd-scan.js'",JSON.stringify(scanUrl));
const {createScanOutbox}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const id='11111111-1111-4111-8111-111111111111';
const token=account=>`header.${btoa(JSON.stringify({sub:account}))}.signature`;
const context={vehicleId:id,sourceId:id,enrollmentId:id,serviceCaseId:id};
const snapshot={scanId:'scan',observedAt:'2026-10-12T00:00:00Z',dtcResponse:'43 03 02\r>'};
function store(){const map=new Map();return {map,list:async()=>[...map.values()],put:async row=>map.set(row.key,structuredClone(row)),remove:async key=>map.delete(key)};}
test('pending scan survives client recreation without storing credentials',async()=>{
  const db=store(),outbox=createScanOutbox(db);await outbox.save(token(id),context,snapshot);
  const recovered=await createScanOutbox(db).restore(token(id),id);
  assert.equal(recovered.scan.scanId,'scan');assert.equal(JSON.stringify(recovered).includes('signature'),false);
});
test('another account cannot restore or remove the pending scan',async()=>{
  const db=store(),outbox=createScanOutbox(db);await outbox.save(token(id),context,snapshot);
  const other='22222222-2222-4222-8222-222222222222';
  assert.equal(await outbox.restore(token(other),id),null);await outbox.remove(token(other),'scan');assert.equal(db.map.size,1);
});
test('same scan retries preserve one outbox entry; completion removes it',async()=>{
  const db=store(),outbox=createScanOutbox(db);await outbox.save(token(id),context,snapshot);await outbox.save(token(id),context,snapshot);
  assert.equal(db.map.size,1);await outbox.remove(token(id),'scan');assert.equal(db.map.size,0);
});
test('expired entries are not restored',async()=>{
  const db=store();await createScanOutbox(db,()=>0).save(token(id),context,snapshot);
  assert.equal(await createScanOutbox(db,()=>8*86400000).restore(token(id),id),null);
});
