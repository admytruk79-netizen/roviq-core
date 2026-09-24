import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { transitionCase } from '../src/services/orchestration.js';

const admin={role:'admin'} as const;

describe('case cancellation final-state snapshot',()=>{
  afterAll(async()=>{await pool.end();});

  it('records cancellation after operational projections are refreshed',async()=>{
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,case_type,state)
       values($1,'maintenance','provider_selection') returning id`,
      [domain.rows[0].id]
    );
    const caseId=serviceCase.rows[0].id as string;
    const plan=await pool.query(
      `insert into fulfillment_plans(service_case_id,version,status,blockers,dependency_snapshot)
       values($1,1,'feasible','[]'::jsonb,'{}'::jsonb) returning id`,
      [caseId]
    );

    await pool.query(
      `insert into case_constraints(
         service_case_id,constraint_type,status,details,source_type,projection_key,source_updated_at
       ) values($1,'customer_time','required','{}'::jsonb,'operational_projection','customer-time',now())`,
      [caseId]
    );
    const before=await pool.query(
      `select projection_key,status from case_constraints where service_case_id=$1`,
      [caseId]
    );
    expect(before.rows).toEqual([
      expect.objectContaining({projection_key:'customer-time',status:'required'})
    ]);

    const cancelled=await transitionCase(admin,caseId,'cancelled',{reason:'acceptance_test'});
    expect(cancelled?.state).toBe('cancelled');

    const projection=await pool.query(
      `select projection_key,status from case_constraints where service_case_id=$1 and projection_key='customer-time'`,
      [caseId]
    );
    expect(projection.rowCount).toBe(0);

    const outcome=await pool.query(
      `select fulfillment_plan_id,outcome,dependency_snapshot
         from completion_outcomes where service_case_id=$1`,
      [caseId]
    );
    expect(outcome.rows[0].fulfillment_plan_id).toBe(plan.rows[0].id);
    expect(outcome.rows[0].outcome).toBe('cancelled');
    expect(outcome.rows[0].dependency_snapshot.constraints)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({projection_key:'customer-time'})]));

    const cancelledPlan=await pool.query(`select status from fulfillment_plans where id=$1`,[plan.rows[0].id]);
    expect(cancelledPlan.rows[0].status).toBe('cancelled');
  });
});
