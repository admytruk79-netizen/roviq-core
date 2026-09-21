import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { upsertNetworkHandoff } from '../src/services/network-execution.js';

describe('network execution adversarial invariants',()=>{
  let caseId:string;
  let planOneId:string;
  let planTwoId:string;

  beforeAll(async()=>{
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,case_type,state)
       values($1,'maintenance','provider_selection') returning id`,
      [domain.rows[0].id]
    );
    caseId=serviceCase.rows[0].id;

    const planOne=await pool.query(
      `insert into fulfillment_plans(service_case_id,version,status,blockers,dependency_snapshot)
       values($1,1,'feasible','[]'::jsonb,'{}'::jsonb) returning id`,
      [caseId]
    );
    planOneId=planOne.rows[0].id;
  });

  afterAll(async()=>{await pool.end();});

  it('does not rebind a historical handoff to a later fulfillment plan',async()=>{
    const initial=await upsertNetworkHandoff({
      caseId,
      handoffType:'transport',
      referenceType:'transport_dispatch',
      referenceId:'historical-dispatch-1',
      status:'assigned'
    });
    expect(initial.fulfillment_plan_id).toBe(planOneId);

    await pool.query(
      `update fulfillment_plans set status='superseded',updated_at=now() where id=$1`,
      [planOneId]
    );
    const planTwo=await pool.query(
      `insert into fulfillment_plans(service_case_id,version,status,blockers,dependency_snapshot)
       values($1,2,'feasible','[]'::jsonb,'{}'::jsonb) returning id`,
      [caseId]
    );
    planTwoId=planTwo.rows[0].id;

    const updated=await upsertNetworkHandoff({
      caseId,
      handoffType:'transport',
      referenceType:'transport_dispatch',
      referenceId:'historical-dispatch-1',
      status:'in_progress'
    });
    expect(updated.fulfillment_plan_id).toBe(planOneId);

    const stored=await pool.query(
      `select fulfillment_plan_id,status from network_handoffs
        where service_case_id=$1 and handoff_type='transport'
          and reference_type='transport_dispatch' and reference_id='historical-dispatch-1'`,
      [caseId]
    );
    expect(stored.rows[0].fulfillment_plan_id).toBe(planOneId);
    expect(stored.rows[0].status).toBe('in_progress');
    expect(stored.rows[0].fulfillment_plan_id).not.toBe(planTwoId);
  });
});
