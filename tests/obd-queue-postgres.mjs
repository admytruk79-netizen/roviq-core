// Runs only against a migrated local acceptance database, never production.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, test} from 'node:test';
import pg from 'pg';
import {claimObdJob, processObdJob, processObdAnalysisBatch} from '../cloudflare/obd-analysis.js';

const url=new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('OBD queue regression requires a local acceptance database');
const pool=new pg.Pool({connectionString:url.toString(),max:4});
after(()=>pool.end());
const sql=async(parts,...values)=>(await pool.query(parts.reduce((s,part,i)=>s+(i?'$'+i:'')+part,''),values)).rows;
const model={AI:{run:async()=>({response:JSON.stringify({summary:'Synthetic scanner evidence; technician review required.',possibleCauses:[],recommendedChecks:[],missingInformation:[]})})}};

async function fixture(run){
  const ids=Object.fromEntries(['actor','vehicle','case','source','consent','enrollment','event'].map(name=>[name,randomUUID()]));
  try {
    const domain=(await pool.query("select id from domains where code='maintenance'")).rows[0];
    assert.ok(domain,'Maintenance domain must be migrated');
    await pool.query("insert into actors(id,actor_type) values($1,'customer')",[ids.actor]);
    await pool.query("insert into customer_vehicles(id,customer_actor_id,make,model) values($1,$2,'SIMULATED','QUEUE TEST')",[ids.vehicle,ids.actor]);
    await pool.query('insert into service_cases(id,domain_id,customer_actor_id,vehicle_id) values($1,$2,$3,$4)',[ids.case,domain.id,ids.actor,ids.vehicle]);
    await pool.query("insert into connected_sources(id,source_type,provider_key) values($1,'roviq_reader','synthetic_ci_scanner')",[ids.source]);
    await pool.query("insert into connected_vehicle_consents(id,vehicle_id,customer_actor_id,consent_version,scopes,retention_until) values($1,$2,$3,'ci-test','[\"vehicle_health\"]',now()+interval '1 hour')",[ids.consent,ids.vehicle,ids.actor]);
    await pool.query("insert into device_enrollments(id,vehicle_id,source_id,consent_id,external_device_id) values($1,$2,$3,$4,$5)",[ids.enrollment,ids.vehicle,ids.source,ids.consent,ids.enrollment]);
    await pool.query("insert into vehicle_health_events(id,vehicle_id,source_id,enrollment_id,service_case_id,event_type,occurred_at,dtc_codes,normalized_signals,deduplication_key) values($1,$2,$3,$4,$5,'obd_scan',now(),'{P0302}','{\"engineRpm\":700}',$6)",[ids.event,ids.vehicle,ids.source,ids.enrollment,ids.case,ids.event]);
    await enqueue(ids);
    await run(ids);
  } finally {
    await pool.query('delete from service_cases where id=$1',[ids.case]);
    await pool.query('delete from vehicle_health_events where id=$1',[ids.event]);
    await pool.query('delete from device_enrollments where id=$1',[ids.enrollment]);
    await pool.query('delete from connected_vehicle_consents where id=$1',[ids.consent]);
    await pool.query('delete from connected_sources where id=$1',[ids.source]);
    await pool.query('delete from customer_vehicles where id=$1',[ids.vehicle]);
    await pool.query('delete from actors where id=$1',[ids.actor]);
  }
}
const enqueue=ids=>pool.query('insert into obd_analysis_jobs(event_id,case_id) values($1,$2) on conflict(event_id) do nothing',[ids.event,ids.case]);
const due=ids=>pool.query("update obd_analysis_jobs set available_at=now()-interval '1 second' where event_id=$1",[ids.event]);
const assessmentCount=async ids=>Number((await pool.query('select count(*) as n from ai_triage_assessments where case_id=$1',[ids.case])).rows[0].n);

test('Postgres: duplicate enqueue and competing claims produce one owned job',()=>fixture(async ids=>{
  await Promise.all([enqueue(ids),enqueue(ids)]);
  const claims=await Promise.all([claimObdJob(sql,ids.event),claimObdJob(sql,ids.event)]);
  assert.equal(claims.filter(Boolean).length,1);
  const result=await processObdJob(sql,model,claims.find(Boolean));
  assert.equal(result.state,'completed_ai');assert.equal(await assessmentCount(ids),1);
}));
test('Postgres: persisted fallback retries reuse one assessment identity',()=>fixture(async ids=>{
  const first=await processObdJob(sql,{},await claimObdJob(sql,ids.event));
  assert.equal(first.state,'retry');assert.equal(first.result.modelStatus,'fallback');
  assert.equal(await claimObdJob(sql,ids.event),null);
  await due(ids);
  const second=await processObdJob(sql,model,await claimObdJob(sql,ids.event));
  assert.equal(second.state,'completed_ai');assert.equal(second.assessment_id,first.assessment_id);assert.equal(await assessmentCount(ids),1);
}));
test('Postgres: expired worker cannot overwrite a replacement lease',()=>fixture(async ids=>{
  const old=await claimObdJob(sql,ids.event);
  await pool.query("update obd_analysis_jobs set lease_until=now()-interval '1 second' where event_id=$1",[ids.event]);
  const replacement=await claimObdJob(sql,ids.event);
  await processObdJob(sql,model,old);assert.equal(await assessmentCount(ids),0);
  assert.equal((await processObdJob(sql,model,replacement)).state,'completed_ai');assert.equal(await assessmentCount(ids),1);
}));
test('Postgres: consent revoked during inference prevents publication',()=>fixture(async ids=>{
  const env={AI:{run:async()=>{
    await pool.query("update connected_vehicle_consents set status='revoked' where id=$1",[ids.consent]);
    return model.AI.run();
  }}};
  assert.equal((await processObdJob(sql,env,await claimObdJob(sql,ids.event))).state,'blocked');assert.equal(await assessmentCount(ids),0);
}));
test('Postgres: reviewed assessments are frozen against retry',()=>fixture(async ids=>{
  const first=await processObdJob(sql,{},await claimObdJob(sql,ids.event));
  await pool.query("update ai_triage_assessments set status='reviewed' where id=$1",[first.assessment_id]);
  await due(ids);assert.equal(await claimObdJob(sql,ids.event),null);
  await processObdAnalysisBatch(sql,model);
  assert.equal((await pool.query('select state from obd_analysis_jobs where event_id=$1',[ids.event])).rows[0].state,'reviewed');
  assert.equal(await assessmentCount(ids),1);
}));
