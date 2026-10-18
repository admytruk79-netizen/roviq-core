import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(command,args,cwd=root){
  const r=spawnSync(command,args,{cwd,stdio:'inherit',env:process.env});
  if(r.error)throw r.error;
  if(r.status!==0)process.exit(r.status??1);
}
run('npm',['ci','--no-audit','--no-fund'],fileURLToPath(new URL('../web',import.meta.url)));
run('npm',['run','build'],fileURLToPath(new URL('../web',import.meta.url)));
run(process.execPath,['scripts/build-service-app.mjs']);
run(process.execPath,['scripts/check-product-builds.mjs']);
