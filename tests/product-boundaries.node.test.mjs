import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {beforeEach,test} from 'node:test';
async function load(path){
  const source=(await readFile(new URL(path,import.meta.url),'utf8')).replace('import.meta.env.VITE_API_BASE_URL','undefined');
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64')}`);
}
const actor=await load('../service/src/session.ts');
const links=await load('../service/src/product-links.ts');
const customer=await load('../web/src/lib/customer-auth.ts');
const values=new Map();
const token=role=>`header.${btoa(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+3600}))}.signature`;
const session=role=>({accessToken:token(role),principal:{role,actorId:role==='admin'?null:`${role}-actor`}});
beforeEach(()=>{values.clear();globalThis.localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};});
test('Customer-only accounts cannot open Actor and leave no bearer tokens behind',async()=>{
  globalThis.fetch=async()=>Response.json(session('customer'));
  await assert.rejects(actor.signIn('customer@test','password'),/no_service_workspace/);
  assert.equal(values.size,0);
});
test('Actor opens only granted business roles and never provisions test identities',async()=>{
  const calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push(String(url));
    return Response.json(String(url).endsWith('/login')?{...session('customer'),roles:[{role:'customer'},{role:'tow'},{role:'parts'}]}:session(JSON.parse(init.body).role));
  };
  assert.deepEqual((await actor.signIn('multi@test','password')).roles,['tow','parts']);
  assert.equal(values.has('roviq_access_token'),false);assert.ok(calls.every(url=>!url.includes('/testing/')));
});
test('Admin opens only Ops without customer or provider impersonation',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(session('admin'));};
  assert.deepEqual((await actor.signIn('admin@test','password')).roles,['admin']);assert.equal(calls,1);
});
test('Old combined-shell sessions cannot restore Customer inside Actor',()=>{
  values.set('roviq_actor_session',JSON.stringify({roles:['customer'],email:'old@test',testMode:false}));
  values.set('roviq_access_token',token('customer'));
  assert.equal(actor.restoreSession(),null);assert.equal(values.size,0);
});
test('Actor-only identity is rejected by Customer without any testing-session request',async()=>{
  const calls=[];let stored='stale';
  await assert.rejects(customer.authenticateCustomer('actor@test','password',{post:async path=>{calls.push(path);return session('partner');},setToken:v=>{stored=v;}}),/requires a granted customer account/);
  assert.deepEqual(calls,['/api/auth/login']);assert.equal(stored,null);
});
test('Customer switches only a granted customer role and stores its scoped token',async()=>{
  let stored=null;const calls=[];
  const result=await customer.authenticateCustomer('multi@test','password',{post:async(path,body)=>{
    calls.push({path,body});return path.endsWith('/login')?{...session('partner'),roles:[{role:'customer',actorId:'customer-actor'}]}:session('customer');
  },setToken:v=>{stored=v;}});
  assert.equal(result.principal.role,'customer');assert.equal(stored,token('customer'));
  assert.deepEqual(calls[1],{path:'/api/auth/switch-role',body:{role:'customer'}});
});
test('Legacy Customer payment links go only to the fixed Customer origin',()=>{
  const route='/cases/11111111-1111-4111-8111-111111111111?payment=success&session_id=cs_test';
  assert.equal(links.legacyCustomerReturn('?open=customer&at='+encodeURIComponent(route)),'https://roviq-core-customer.pages.dev'+route);
  for(const route of ['https://evil.test','//evil.test','/cases/../../evil','/cases/not-a-uuid'])assert.equal(links.legacyCustomerReturn('?open=customer&at='+encodeURIComponent(route)),null);
});
