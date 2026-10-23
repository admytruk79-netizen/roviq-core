import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { evaluateFulfillmentCompletion, recordCompletionOutcome } from '../src/services/network-execution.js';

const admin={'x-roviq-role':'admin','x-admin-api-key':process.env.ADMIN_API_KEY!};
describe('completion dependency checks without a fulfillment plan',()=>{
  let app:FastifyInstance;
  beforeAll(async()=>{app=await buildApp();});
  afterAll(async()=>{await app.close();await pool.end();});
  async function fixture(){
    const r=await pool.query(`insert into service_cases(domain_id,case_type,state)
      select id,'maintenance','payment_pending' from domains where code='maintenance' returning id`);
    return r.rows[0].id as string;
  }
  async function handoff(caseId:string,status:string,planId:string|null=null){
    return (await pool.query(`insert into network_handoffs(service_case_id,fulfillment_plan_id,handoff_type,reference_type,reference_id,status)
      values($1,$2,'transport','test',$3,$4) returning id`,[caseId,planId,randomUUID(),status])).rows[0].id as string;
  }
  it('shows pending legacy dependencies and writes no completion outcome while blocked',async()=>{
    const id=await fixture(); await handoff(id,'in_progress');
    await pool.query(`insert into case_constraints(service_case_id,constraint_type,status,details)
      values($1,'approval','required','{}')`,[id]);
    const response=await app.inject({method:'GET',url:`/api/admin/maintenance/cases/${id}/fulfillment-readiness`,headers:admin});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({plan:null,ready:false,verificationMode:'legacy_dependency_check'});
    expect(response.json().blockers).toHaveLength(2);
    const transition=await app.inject({method:'POST',url:`/api/maintenance/cases/${id}/transition`,headers:admin,payload:{toState:'completed'}});
    expect(transition.statusCode).toBe(409);
    expect(transition.json().error).toBe('fulfillment_not_complete');
    expect((await pool.query('select state from service_cases where id=$1',[id])).rows[0].state).toBe('payment_pending');
    await expect(recordCompletionOutcome({caseId:id})).rejects.toMatchObject({message:'fulfillment_not_complete'});
    expect((await pool.query('select id from completion_outcomes where service_case_id=$1',[id])).rowCount).toBe(0);
  });
  it('records genuine legacy dependency evidence once all recorded work is terminal',async()=>{
    const id=await fixture(); const ref=await handoff(id,'accepted');
    await expect(recordCompletionOutcome({caseId:id})).rejects.toThrow('fulfillment_not_complete');
    await pool.query(`update network_handoffs set status='completed' where id=$1`,[ref]);
    const result=await recordCompletionOutcome({caseId:id,evidence:{source:'acceptance_fixture'}});
    expect(result.fulfillment_plan_id).toBeNull();
    expect(result.dependency_snapshot).toMatchObject({verificationMode:'legacy_dependency_check',handoffs:[{status:'completed'}]});
  });
  it('does not skip an unbound handoff when a current accepted plan exists',async()=>{
    const id=await fixture(); await handoff(id,'assigned');
    const p=await pool.query(`insert into fulfillment_plans(service_case_id,version,status,blockers,dependency_snapshot)
      values($1,1,'accepted','[]','{}') returning id`,[id]);
    expect((await evaluateFulfillmentCompletion(id)).ready).toBe(false);
    await expect(recordCompletionOutcome({caseId:id})).rejects.toThrow('fulfillment_not_complete');
    // A completed handoff for another case must never be included in this snapshot.
    const other=await fixture(); await handoff(other,'completed',p.rows[0].id);
    const check=await evaluateFulfillmentCompletion(id);
    expect(check.handoffs).toHaveLength(1);
    expect(check.verificationMode).toBe('coordinated_plan');
  });
  it('preserves simple legacy completion without inventing a fulfillment plan',async()=>{
    const id=await fixture(); const result=await recordCompletionOutcome({caseId:id});
    expect(result.fulfillment_plan_id).toBeNull();
    expect(result.dependency_snapshot).toEqual({verificationMode:'legacy_dependency_check',constraints:[],handoffs:[]});
    expect((await pool.query('select id from fulfillment_plans where service_case_id=$1',[id])).rowCount).toBe(0);
  });
});
