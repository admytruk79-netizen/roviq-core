import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const path=relative=>fileURLToPath(new URL('../'+relative,import.meta.url));
for(const [dir,name] of [['web','ROVIQ Customer'],['service','ROVIQ Actor'],['ops','ROVIQ Ops']]){
  const manifest=JSON.parse(readFileSync(path(`${dir}/dist/manifest.json`),'utf8'));
  assert.equal(manifest.name,name);assert.equal(manifest.start_url,'/');
  assert.ok(readFileSync(path(`${dir}/dist/index.html`),'utf8').includes(`<title>${name}</title>`));
}
assert.equal(existsSync(path('service/dist/customer')),false,'Actor must not contain Customer');
assert.equal(existsSync(path('service/dist/ops')),false,'Ops must not be packaged inside Actor');
for(const role of ['diagnostic','tow','partner','parts','fleet']){
  assert.ok(existsSync(path(`service/dist/${role}/index.html`)),`Missing Actor workspace: ${role}`);
  assert.equal(existsSync(path(`web/dist/${role}/index.html`)),false,'Customer must not package Actor workspaces');
}
console.log('Verified three products: Customer, Actor and Ops, with separate manifests and workspace outputs.');
