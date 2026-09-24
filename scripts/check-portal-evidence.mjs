import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const [portalDir]=process.argv.slice(2);
if(!portalDir){
  console.error('usage: node scripts/check-portal-evidence.mjs <portal-directory>');
  process.exit(2);
}

const dist=path.resolve(portalDir,'dist');
const indexPath=path.join(dist,'index.html');
const html=await readFile(indexPath,'utf8');

const failures=[];
if(!/<html[^>]*\blang=["']en["']/i.test(html)) failures.push('index.html must declare lang="en"');
if(!/<meta[^>]+name=["']viewport["'][^>]*>/i.test(html)) failures.push('index.html must define a viewport');
if(!/<title>[^<]+<\/title>/i.test(html)) failures.push('index.html must have a non-empty title');

async function walk(dir){
  const entries=await readdir(dir,{withFileTypes:true});
  const files=[];
  for(const entry of entries){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const files=await walk(dist);
let jsBytes=0,cssBytes=0,totalBytes=0;
for(const file of files){
  const size=(await stat(file)).size;
  totalBytes+=size;
  if(file.endsWith('.js')) jsBytes+=size;
  if(file.endsWith('.css')) cssBytes+=size;
}

const budgets={
  js: 1_750_000,
  css: 600_000,
  total: 3_500_000
};
if(jsBytes>budgets.js) failures.push(`JavaScript budget exceeded: ${jsBytes} > ${budgets.js}`);
if(cssBytes>budgets.css) failures.push(`CSS budget exceeded: ${cssBytes} > ${budgets.css}`);
if(totalBytes>budgets.total) failures.push(`Total dist budget exceeded: ${totalBytes} > ${budgets.total}`);

const report={
  portal:portalDir,
  accessibilityBaseline:{
    htmlLang:/<html[^>]*\blang=["']en["']/i.test(html),
    viewport:/<meta[^>]+name=["']viewport["'][^>]*>/i.test(html),
    title:/<title>[^<]+<\/title>/i.test(html)
  },
  performance:{
    jsBytes,
    cssBytes,
    totalBytes,
    budgets
  }
};
console.log(JSON.stringify(report,null,2));

if(failures.length){
  for(const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
