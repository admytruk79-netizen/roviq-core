import {readFile,mkdir,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('../cloudflare/obd-analysis.js',import.meta.url),'utf8');
const {claimObdJob,processObdJob}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const fallback = process.argv[2] === 'fallback';
const eventId=id(fallback ? 8708 : 8707),caseId=id(8703);
const job={event_id:eventId,case_id:caseId,attempt_count:1,lease_token:null};
const statements=[];
let permissionQuery;
const literal=value=>value===null?'NULL':typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;
const sql=async(parts,...values)=>{
  const query=parts.map((part,i)=>part+(i<values.length?literal(values[i]):'')).join('');
  if(query.includes('with candidate as')){job.lease_token=values.at(-1);statements.push(query);return [job];}
  if(query.includes('select e.*')) {permissionQuery=query;return [{dtc_codes:['P0302'],normalized_signals:{engineRpm:700},occurred_at:'2026-10-12T00:00:00Z'}];}
  if(query.includes('with owned as')){statements.push(query);return [{state:'completed_ai'}];}
  throw new Error('Unexpected capture query');
};
await claimObdJob(sql,eventId);
await processObdJob(sql,fallback ? {} : {AI:{run:async()=>({response:JSON.stringify({summary:'Synthetic misfire observation for queue verification',possibleCauses:[],missingInformation:['Vehicle details'],recommendedChecks:[]})})}},job);
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
await writeFile(new URL(`../artifacts/obd-queue-sql${fallback ? '-fallback' : ''}.json`,import.meta.url),JSON.stringify(statements,null,2));
await writeFile(new URL('../artifacts/obd-permission-query.json',import.meta.url),JSON.stringify(permissionQuery));
console.log('Captured actual job claim/publication SQL for isolated PostgreSQL validation.');
