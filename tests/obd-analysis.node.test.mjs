import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const source=await readFile(new URL('../cloudflare/obd-analysis.js',import.meta.url),'utf8');
const module=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const event={id:'event',dtc_codes:['P0302'],normalized_signals:{engineRpm:700},occurred_at:'2026-10-12T00:00:00Z'};
const ai={AI:{run:async()=>({response:JSON.stringify({summary:'Misfire code observed; cause unconfirmed.',possibleCauses:[{cause:'Ignition fault',dtcEvidence:['P0302'],signalEvidence:[]}],recommendedChecks:['Inspect ignition components'],missingInformation:['Vehicle model and test results']})})}};
test('AI output is explicit and hypotheses remain grounded in scanner evidence',async()=>{
  const result=await module.inferObdAnalysis(ai,event);
  assert.equal(result.modelStatus,'ai');assert.equal(result.possibleCauses[0].confirmed,false);
  assert.equal(result.requiresTechnicianConfirmation,true);
});
test('fabricated codes and measurements cannot ground a hypothesis',()=>{
  const result=module.normalizeObdAnalysis({summary:'Review required',possibleCauses:[{cause:'Invented',dtcEvidence:['P9999'],signalEvidence:[{name:'engineRpm',value:9000}]}]},event);
  assert.deepEqual(result.possibleCauses,[]);
});
test('missing AI, malformed output and timeout produce explicit fallback status',async()=>{
  for(const env of [{},{AI:{run:async()=>({response:'broken'})}},{AI:{run:()=>new Promise(()=>{})}}]){
    const result=await module.inferObdAnalysis(env,event,5);
    assert.equal(result.modelStatus,'fallback');assert.ok(result.failureReason);assert.deepEqual(result.possibleCauses,[]);
  }
});
function fixture(){
  const state={valid:true,lease:'lease-1',assessmentWrites:0,job:null};
  const sql=async(parts,...values)=>{
    const query=parts.join('?');
    if(query.includes('select e.*')) return state.valid?[event]:[];
    if(query.includes('with owned as')){
      if(values[5]!==state.lease)return [];
      state.job={state:values[0],result:JSON.parse(values[1]),assessment_id:'fixed-assessment'};
      state.assessmentWrites++;return [state.job];
    }
    if(query.startsWith('update obd_analysis_jobs')){if(values.at(-1)===state.lease)state.job={state:'blocked'};return [];}
    throw new Error('Unimplemented query');
  };
  return {state,sql,job:{event_id:'event',case_id:'case',lease_token:'lease-1',attempt_count:1}};
}
test('failed inference persists fallback with retry and fixed assessment identity',async()=>{
  const f=fixture();const result=await module.processObdJob(f.sql,{},f.job);
  assert.equal(result.state,'retry');assert.equal(result.result.modelStatus,'fallback');assert.equal(result.assessment_id,'fixed-assessment');
});
test('last failed attempt becomes completed fallback, never completed AI',async()=>{
  const f=fixture();f.job.attempt_count=5;
  assert.equal((await module.processObdJob(f.sql,{},f.job)).state,'completed_fallback');
});
test('stale worker lease cannot publish an assessment',async()=>{
  const f=fixture();f.state.lease='new-lease';
  await module.processObdJob(f.sql,ai,f.job);assert.equal(f.state.assessmentWrites,0);
});
test('consent lost during inference blocks publication',async()=>{
  const f=fixture();const env={AI:{run:async()=>{f.state.valid=false;return ai.AI.run();}}};
  assert.equal((await module.processObdJob(f.sql,env,f.job)).state,'blocked');assert.equal(f.state.assessmentWrites,0);
});

const eventId='00000000-0000-4000-8000-000000008707';
const caseId='00000000-0000-4000-8000-000000008703';
function analysisRequest(body={eventId,caseId},authenticated=true){
  return new Request('https://roviq.test/api/connected/obd-analysis',{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer scoped-test-token'}:{})},body:JSON.stringify(body)});
}
test('analysis endpoint requires authentication and valid persisted event identity',async()=>{
  const sql=()=>{throw new Error('Database must not be accessed');};
  assert.equal((await module.requestObdAnalysis(analysisRequest(undefined,false),{CORE_API_URL:'https://core.test'},sql)).status,401);
  assert.equal((await module.requestObdAnalysis(analysisRequest({eventId:'fake',caseId}),{CORE_API_URL:'https://core.test'},sql)).status,400);
});
test('cross-case access fails before queue reads or writes',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async url=>String(url).endsWith('/api/auth/roles')?Response.json({active:{role:'diagnostic'}}):new Response('{}',{status:403});
    const result=await module.requestObdAnalysis(analysisRequest(),{CORE_API_URL:'https://core.test'},()=>{throw new Error('Database must not be accessed');});
    assert.equal(result.status,403);
  } finally {globalThis.fetch=original;}
});
test('repeated analysis requests reuse the event job and fixed assessment',async()=>{
  const original=globalThis.fetch;const jobs=new Map();let attempts=0;
  try {
    globalThis.fetch=async url=>Response.json(String(url).endsWith('/api/auth/roles')?{active:{role:'customer'}}:{case:{id:caseId}});
    const sql=async(parts,...values)=>{
      const query=parts.join('?');
      if(query.includes('select e.*'))return [event];
      if(query.startsWith('insert into obd_analysis_jobs')){
        attempts++;if(!jobs.has(values[0]))jobs.set(values[0],{event_id:values[0],state:'pending',result:null,assessment_id:'fixed-assessment'});return [];
      }
      if(query.startsWith('select event_id,state,result'))return [jobs.get(values[0])];
      throw new Error('Unexpected query');
    };
    const one=await module.requestObdAnalysis(analysisRequest(),{CORE_API_URL:'https://core.test'},sql);
    const two=await module.requestObdAnalysis(analysisRequest(),{CORE_API_URL:'https://core.test'},sql);
    assert.equal(attempts,2);assert.equal(jobs.size,1);assert.equal(one.status,202);assert.equal(two.job.assessment_id,one.job.assessment_id);
    assert.equal(two.analysisPending,true);
  } finally {globalThis.fetch=original;}
});
test('Core outage fails closed without queuing model input',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{throw new Error('offline');};
    assert.equal((await module.requestObdAnalysis(analysisRequest(),{CORE_API_URL:'https://core.test'},()=>{throw new Error('Database must not be accessed');})).status,503);
  } finally {globalThis.fetch=original;}
});
