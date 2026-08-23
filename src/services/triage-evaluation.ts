import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { audit } from './audit.js';

export async function recordGroundTruth(principal:Principal,input:{assessmentId:string;confirmedDrivability:string;confirmedCapabilities:string[];confirmedSafetyFlags:string[];confirmedFaultCategory?:string;notes?:string}) {
  if (!['admin','diagnostic','partner'].includes(principal.role)) throw new Error('forbidden');
  const r=await pool.query(
    `insert into triage_ground_truth(assessment_id,confirmed_drivability,confirmed_capabilities,confirmed_safety_flags,confirmed_fault_category,reviewer_actor_id,notes)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict(assessment_id) do update set confirmed_drivability=excluded.confirmed_drivability,confirmed_capabilities=excluded.confirmed_capabilities,confirmed_safety_flags=excluded.confirmed_safety_flags,confirmed_fault_category=excluded.confirmed_fault_category,reviewer_actor_id=excluded.reviewer_actor_id,notes=excluded.notes
     returning *`,
    [input.assessmentId,input.confirmedDrivability,JSON.stringify(input.confirmedCapabilities),JSON.stringify(input.confirmedSafetyFlags),input.confirmedFaultCategory??null,principal.actorId??null,input.notes??null]
  );
  await audit(principal,'record_triage_ground_truth','triage_ground_truth',r.rows[0].id,'evaluation',{assessmentId:input.assessmentId});
  return r.rows[0];
}

export async function evaluateTriage(principal:Principal,engineVersion?:string) {
  if (principal.role!=='admin') throw new Error('forbidden');
  const policyR=await pool.query(`select * from triage_promotion_policy where active=true order by updated_at desc limit 1`);
  const policy=policyR.rows[0]??{minimum_sample_size:200,minimum_safety_recall:0.995,minimum_drivability_accuracy:0.95,minimum_capability_recall:0.95,maximum_critical_misses:0};
  const params:any[]=[];
  const where=engineVersion?'where a.engine_version=$1':'';
  if(engineVersion) params.push(engineVersion);
  const r=await pool.query(
    `select a.id,a.engine_version,a.suggested_drivability,a.suggested_capabilities,a.safety_flags,g.confirmed_drivability,g.confirmed_capabilities,g.confirmed_safety_flags
     from ai_triage_assessments a join triage_ground_truth g on g.assessment_id=a.id ${where}` ,params);
  const rows=r.rows;
  let drivabilityCorrect=0, safetyTP=0, safetyFN=0, capabilityTP=0, capabilityFN=0, criticalMisses=0;
  for(const x of rows){
    if(x.suggested_drivability===x.confirmed_drivability) drivabilityCorrect++;
    const predictedSafety=new Set((x.safety_flags??[]).map((v:any)=>typeof v==='string'?v:v.code));
    const trueSafety=new Set((x.confirmed_safety_flags??[]).map(String));
    for(const flag of trueSafety){ if(predictedSafety.has(flag)) safetyTP++; else { safetyFN++; criticalMisses++; } }
    const predictedCaps=new Set((x.suggested_capabilities??[]).map(String));
    const trueCaps=new Set((x.confirmed_capabilities??[]).map(String));
    for(const cap of trueCaps){ if(predictedCaps.has(cap)) capabilityTP++; else capabilityFN++; }
  }
  const sampleSize=rows.length;
  const metrics={
    sampleSize,
    drivabilityAccuracy:sampleSize?drivabilityCorrect/sampleSize:0,
    safetyRecall:(safetyTP+safetyFN)?safetyTP/(safetyTP+safetyFN):1,
    capabilityRecall:(capabilityTP+capabilityFN)?capabilityTP/(capabilityTP+capabilityFN):1,
    criticalMisses
  };
  const gates={
    sampleSize:sampleSize>=Number(policy.minimum_sample_size),
    safetyRecall:metrics.safetyRecall>=Number(policy.minimum_safety_recall),
    drivabilityAccuracy:metrics.drivabilityAccuracy>=Number(policy.minimum_drivability_accuracy),
    capabilityRecall:metrics.capabilityRecall>=Number(policy.minimum_capability_recall),
    criticalMisses:criticalMisses<=Number(policy.maximum_critical_misses)
  };
  const passed=Object.values(gates).every(Boolean);
  const version=engineVersion??rows[0]?.engine_version??'mixed';
  const saved=await pool.query(`insert into triage_evaluation_runs(engine_version,sample_size,metrics,gates,passed) values($1,$2,$3,$4,$5) returning *`,[version,sampleSize,JSON.stringify(metrics),JSON.stringify(gates),passed]);
  await audit(principal,'run_triage_evaluation','triage_evaluation_run',saved.rows[0].id,passed?'passed':'failed',{engineVersion:version});
  return saved.rows[0];
}
