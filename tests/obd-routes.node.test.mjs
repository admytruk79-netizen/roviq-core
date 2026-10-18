import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';

async function moduleFrom(file, prefix = '') {
  const raw = await readFile(new URL(file, import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(prefix + raw.replace(/^import .*;\n/gm, ''), {mode:'transform'});
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const policy = await moduleFrom('../src/services/obd-access-policy.ts');
globalThis.obdRoutePolicy = policy;
const routes = await moduleFrom('../src/http/routes/connected-vehicles.ts', `
const chain = new Proxy(function(){return chain}, {get(_target,key){return key==='parse' ? value=>value : chain}});
const z = chain; // Validation is tested by the real Zod/HTTP suite, not this harness.
const pool = {query:(...args)=>globalThis.obdRouteDb.query(...args),connect:()=>globalThis.obdRouteDb.connect()};
const audit=async()=>{}; const appendCaseEvent=async()=>{};
const requireRole=(...roles)=>({roles});
const loadCaseForPrincipal=async()=>globalThis.obdRouteDb.caseRecord;
const healthEventDedupKey=()=> 'mock-stable-event';
const syncRepairAuthorizationOperationalConstraint=async()=>{};
const {assertTechnicianScanCase,assertScanConsent}=globalThis.obdRoutePolicy;
`);
const handlers = new Map();
const app = {get(path, ...args){handlers.set(`GET ${path}`,args.at(-1));},post(path,...args){handlers.set(`POST ${path}`,args.at(-1));},patch(path,...args){handlers.set(`PATCH ${path}`,args.at(-1));}};
await routes.connectedVehicleRoutes(app);
function fixture(change = {}) {
  const record = {vehicle_id:'vehicle',customer_actor_id:'customer',current_owner_actor_id:'operator',state:'diagnostic_pending'};
  const state = {caseRecord:record, writes:[], consent:{enrollment_status:'active',consent_status:'active',customer_actor_id:'customer',scopes:['vehicle_health']}, ...change};
  state.query = async (raw,p=[]) => {
    const sql=raw.replace(/\s+/g,' ').trim();
    const rows=list=>({rows:list,rowCount:list.length});
    if(['begin','commit','rollback'].includes(sql)) return rows([]);
    if(sql.startsWith('select * from connected_sources')) return rows([{status:'active',source_type:'roviq_reader',organization_id:null}]);
    if(sql.includes('select de.*,cvc.status')) return rows([state.consent]);
    if(sql.startsWith('insert into vehicle_health_events')) {state.writes.push(sql);return rows([{id:'event',vehicle_id:'vehicle',service_case_id:'case'}]);}
    if(sql.startsWith('select de.id,de.consent_id')) return rows([{id:'enrollment',consent_id:'consent',customer_actor_id:'customer'}]);
    if(sql.startsWith('update')) {state.writes.push(sql);return rows([]);}
    throw new Error(`Unsupported query: ${sql}`);
  };
  state.connect = async()=>({query:state.query,release(){}});
  globalThis.obdRouteDb=state;
  return state;
}
const body={vehicleId:'vehicle',sourceId:'source',enrollmentId:'enrollment',serviceCaseId:'case',eventType:'obd_scan',severity:'advisory',safetyState:'review_required',occurredAt:'2026-10-12T00:00:00Z',dtcCodes:['P0302'],normalizedSignals:{},rawReference:{},metadata:{}};
function reply(){return {status:200,code(status){this.status=status;return this;},send(body){this.body=body;return body;}};}
test('actual ingestion handler records a consented assigned-technician scan',async()=>{
  const state=fixture(); const res=reply();
  await handlers.get('POST /api/connected/health-events')({principal:{role:'diagnostic',actorId:'operator'},body},res);
  assert.equal(res.status,201);assert.ok(state.writes.some(sql=>sql.startsWith('insert')));
});
test('actual ingestion rejects an unrelated technician before any writes',async()=>{
  const state=fixture();
  await assert.rejects(handlers.get('POST /api/connected/health-events')({principal:{role:'diagnostic',actorId:'outsider'},body},reply()),/scan_assignment_required/);
  assert.equal(state.writes.length,0);
});
test('actual ingestion rejects revoked customer consent before recording data',async()=>{
  const state=fixture();state.consent.consent_status='revoked';
  await assert.rejects(handlers.get('POST /api/connected/health-events')({principal:{role:'diagnostic',actorId:'operator'},body},reply()),/scan_consent_not_active/);
  assert.equal(state.writes.length,0);
});
test('consent owner can revoke while another customer cannot',async()=>{
  for(const actorId of ['outsider','customer']){
    const state=fixture();const res=reply();
    await handlers.get('POST /api/connected/enrollments/:id/revoke')({principal:{role:'customer',actorId},params:{id:'enrollment'}},res);
    if(actorId==='outsider'){assert.equal(res.status,403);assert.equal(state.writes.length,0);}
    else {assert.equal(state.writes.length,2);assert.ok(state.writes[0].includes('revoked_at'));}
  }
});
