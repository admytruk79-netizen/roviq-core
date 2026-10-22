import { describe, expect, it } from 'vitest';
import { loadActorQualifications } from './serviceability-gate.js';

const at = new Date('2026-10-22T12:00:00Z');
const requirement = {requirement_key:'ev-hv', kind:'training', scope:'vehicle-x/hv', mandatory:true};
function db(requirements:any[], evidence:any[]){
 return {query:async(sql:string)=>{
   if(sql.includes('from case_qualification_requirements')) return {rows:requirements,rowCount:requirements.length};
   if(sql.includes('from actor_qualification_evidence')) return {rows:evidence,rowCount:evidence.length};
   throw Error('unexpected qualification SQL');
 }} as any;
}
describe('MACRE evidence retrieval',()=>{
 it('does not block legacy cases without configured requirements',async()=>{
   expect((await loadActorQualifications('case','actor',db([],[]),at)).decision).toBe('eligible');
 });
 it('blocks missing mandatory verified qualifications',async()=>{
   expect((await loadActorQualifications('case','actor',db([requirement],[]),at)).decision).toBe('blocked');
 });
 it('rejects unproven status even when marked verified',async()=>{
   const evidence=[{requirement_key:'ev-hv',kind:'training',scope:'vehicle-x/hv',evidence_status:'verified',verified_source:null}];
   expect((await loadActorQualifications('case','actor',db([requirement],evidence),at)).decision).toBe('blocked');
 });
 it('rejects a whitespace-only verification source',async()=>{
   const evidence=[{requirement_key:'ev-hv',kind:'training',scope:'vehicle-x/hv',evidence_status:'verified',verified_source:'   '}];
   expect((await loadActorQualifications('case','actor',db([requirement],evidence),at)).decision).toBe('blocked');
 });
 it('accepts current evidence with provenance and matching scope',async()=>{
   const evidence=[{requirement_key:'ev-hv',kind:'training',scope:'vehicle-x/hv',evidence_status:'verified',verified_source:'oem-portal',valid_until:'2027-01-01'}];
   expect((await loadActorQualifications('case','actor',db([requirement],evidence),at)).decision).toBe('eligible');
 });
 it('blocks expired verified evidence',async()=>{
   const evidence=[{requirement_key:'ev-hv',kind:'training',scope:'vehicle-x/hv',evidence_status:'verified',verified_source:'oem-portal',valid_until:'2025-01-01'}];
   expect((await loadActorQualifications('case','actor',db([requirement],evidence),at)).decision).toBe('blocked');
 });
});
