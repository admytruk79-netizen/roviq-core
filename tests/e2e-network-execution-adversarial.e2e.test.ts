import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { syncFulfillmentParticipantDecision, upsertNetworkHandoff } from '../src/services/network-execution.js';

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


  it('does not mark a provider-accepted plan executable while canonical constraints are pending',async()=>{
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,case_type,state)
       values($1,'maintenance','provider_pending') returning id`,
      [domain.rows[0].id]
    );
    const constrainedCaseId=serviceCase.rows[0].id as string;
    const provider=await pool.query(
      `insert into actors(actor_type,status) values('shop','active') returning id`
    );
    const providerId=provider.rows[0].id as string;
    const plan=await pool.query(
      `insert into fulfillment_plans(service_case_id,version,status,blockers,dependency_snapshot)
       values($1,1,'feasible','[]'::jsonb,'{}'::jsonb) returning id`,
      [constrainedCaseId]
    );
    const candidate=await pool.query(
      `insert into fulfillment_candidates(fulfillment_plan_id,actor_id,rank,serviceability,signals)
       values($1,$2,1,'{}'::jsonb,'{}'::jsonb) returning id`,
      [plan.rows[0].id,providerId]
    );
    await pool.query(
      `insert into case_constraints(service_case_id,constraint_type,status,details)
       values($1,'parts','required','{}'::jsonb)`,
      [constrainedCaseId]
    );

    await syncFulfillmentParticipantDecision({
      caseId:constrainedCaseId,
      actorId:providerId,
      decision:'accepted',
      sourceType:'match_offer',
      sourceReferenceId:'offer-pending-parts'
    });

    const blocked=await pool.query(
      `select status,selected_actor_id,recovery_required_at from fulfillment_plans where id=$1`,
      [plan.rows[0].id]
    );
    expect(blocked.rows[0].status).toBe('blocked');
    expect(blocked.rows[0].selected_actor_id).toBe(providerId);
    expect(blocked.rows[0].recovery_required_at).toBeNull();

    await pool.query(
      `update case_constraints set status='satisfied',updated_at=now()
        where service_case_id=$1 and constraint_type='parts'`,
      [constrainedCaseId]
    );
    await upsertNetworkHandoff({
      caseId:constrainedCaseId,
      handoffType:'service_provider',
      participantActorId:providerId,
      referenceType:'match_offer',
      referenceId:'offer-pending-parts',
      status:'accepted'
    });

    const accepted=await pool.query(
      `select status,selected_actor_id,recovery_required_at from fulfillment_plans where id=$1`,
      [plan.rows[0].id]
    );
    expect(accepted.rows[0].status).toBe('accepted');
    expect(accepted.rows[0].selected_actor_id).toBe(providerId);
    expect(accepted.rows[0].recovery_required_at).toBeNull();

    const participant=await pool.query(
      `select decision,fulfillment_candidate_id from participant_acceptances
        where fulfillment_plan_id=$1 and actor_id=$2`,
      [plan.rows[0].id,providerId]
    );
    expect(participant.rows[0]).toMatchObject({
      decision:'accepted',
      fulfillment_candidate_id:candidate.rows[0].id
    });
  });


  it('keeps a failed provider handoff in recovery until an explicit replan',async()=>{
    const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
    const serviceCase=await pool.query(
      `insert into service_cases(domain_id,case_type,state)
       values($1,'maintenance','repair_in_progress') returning id`,
      [domain.rows[0].id]
    );
    const recoveryCaseId=serviceCase.rows[0].id as string;
    const provider=await pool.query(
      `insert into actors(actor_type,status) values('shop','active') returning id`
    );
    const providerId=provider.rows[0].id as string;
    const plan=await pool.query(
      `insert into fulfillment_plans(
         service_case_id,version,status,selected_actor_id,blockers,dependency_snapshot
       ) values($1,1,'accepted',$2,'[]'::jsonb,'{}'::jsonb) returning id`,
      [recoveryCaseId,providerId]
    );
    await pool.query(
      `insert into fulfillment_candidates(
         fulfillment_plan_id,actor_id,rank,participant_status,serviceability,signals
       ) values($1,$2,1,'accepted','{}'::jsonb,'{}'::jsonb)`,
      [plan.rows[0].id,providerId]
    );
    await pool.query(
      `insert into participant_acceptances(
         fulfillment_plan_id,service_case_id,actor_id,decision,source_type
       ) values($1,$2,$3,'accepted','match_offer')`,
      [plan.rows[0].id,recoveryCaseId,providerId]
    );

    await upsertNetworkHandoff({
      caseId:recoveryCaseId,
      handoffType:'service_provider',
      participantActorId:providerId,
      referenceType:'match_offer',
      referenceId:'offer-recovery-test',
      status:'failed'
    });

    const afterFailure=await pool.query(
      `select status,recovery_required_at,recovery_reason from fulfillment_plans where id=$1`,
      [plan.rows[0].id]
    );
    expect(afterFailure.rows[0].status).toBe('blocked');
    expect(afterFailure.rows[0].recovery_required_at).toBeTruthy();
    expect(afterFailure.rows[0].recovery_reason).toBe('service_provider_failed');

    await upsertNetworkHandoff({
      caseId:recoveryCaseId,
      handoffType:'service_provider',
      participantActorId:providerId,
      referenceType:'match_offer',
      referenceId:'offer-recovery-test',
      status:'completed'
    });

    const stillRecovering=await pool.query(
      `select status,recovery_required_at from fulfillment_plans where id=$1`,
      [plan.rows[0].id]
    );
    expect(stillRecovering.rows[0].status).toBe('blocked');
    expect(stillRecovering.rows[0].recovery_required_at).toBeTruthy();
  });

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
