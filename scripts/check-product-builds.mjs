import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const path=relative=>fileURLToPath(new URL('../'+relative,import.meta.url));
for(const [dir,name] of [['web','ROVIQ Customer'],['service','ROVIQ Actor']]){
  const manifest=JSON.parse(readFileSync(path(`${dir}/dist/manifest.json`),'utf8'));
  assert.equal(manifest.name,name);assert.equal(manifest.start_url,'/');
  assert.ok(readFileSync(path(`${dir}/dist/index.html`),'utf8').includes(`<title>${name}</title>`));
}
assert.equal(existsSync(path('service/dist/customer')),false,'Actor must not contain Customer');
for(const role of ['diagnostic','tow','partner','parts','fleet','ops']){
  assert.ok(existsSync(path(`service/dist/${role}/index.html`)),`Missing Actor workspace: ${role}`);
  assert.equal(existsSync(path(`web/dist/${role}/index.html`)),false,'Customer must not package Actor workspaces');
}
console.log('Verified two products: Customer and Actor, with separate manifests and workspace outputs.');
