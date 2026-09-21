import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { assignSupplier, createPartsOrder, markPartsOrderStatus, reserveOrderInventory, upsertInventory } from '../src/services/parts.js';
import { assignMobility, createMobilityResource, requestMobility, updateMobilityState } from '../src/services/mobility.js';
import { assignTransportDispatch, createTransportDispatch, updateTransportStatus } from '../src/services/transport.js';

const admin={role:'admin'} as const;

async function domainId(){
  const result=await pool.query(`select id from domains where code='maintenance' limit 1`);
  return result.rows[0].id as string;
}

async function createCase(state='provider_selection'){
  const result=await pool.query(
    `insert into service_cases(domain_id,case_type,state)
     values($1,'maintenance',$2) returning id`,
    [await domainId(),state]
  );
  return result.rows[0].id as string;
}

async function createPlan(caseId:string){
  const result=await pool.query(
    `insert into fulfillment_plans(service_case_id,version,status,blockers,dependency_snapshot)
     values($1,1,'feasible','[]'::jsonb,'{}'::jsonb) returning id`,
    [caseId]
  );
  return result.rows[0].id as string;
}

describe('cross-domain failure and reassignment recovery',()=>{
  beforeEach(async()=>{
    // Each case in this file is independent. No global mutable fixture is shared.
  });
  afterAll(async()=>{await pool.end();});

  it('reassigns a failed parts order without silently clearing fulfillment recovery',async()=>{
    const caseId=await createCase();
    const planId=await createPlan(caseId);
    const supplierA=(await pool.query(`insert into actors(actor_type,status) values('parts','active') returning id`)).rows[0].id as string;
    const supplierB=(await pool.query(`insert into actors(actor_type,status) values('parts','active') returning id`)).rows[0].id as string;
    const sku=`RECOVERY-PART-${Date.now()}-${Math.random()}`;

    const created=await createPartsOrder(admin,{caseId,items:[{sku,quantity:1}]});
    const orderId=created!.order.id as string;
    await assignSupplier(admin,orderId,supplierA);
    await upsertInventory(admin,{supplierActorId:supplierA,sku,quantityOnHand:2,unitPrice:25});
    await reserveOrderInventory(admin,orderId);
    await markPartsOrderStatus(admin,orderId,'ordered');
    await markPartsOrderStatus(admin,orderId,'failed',{reason:'supplier_failure'});

    const failed=await pool.query(
      `select status,recovery_required_at,recovery_reason from fulfillment_plans where id=$1`,
      [planId]
    );
    expect(failed.rows[0].status).toBe('blocked');
    expect(failed.rows[0].recovery_required_at).toBeTruthy();
    expect(failed.rows[0].recovery_reason).toBe('parts_failed');

    await upsertInventory(admin,{supplierActorId:supplierB,sku,quantityOnHand:2,unitPrice:24});
    const reassigned=await assignSupplier(admin,orderId,supplierB);
    expect(reassigned!.order.status).toBe('supplier_assigned');
    expect(reassigned!.order.supplier_actor_id).toBe(supplierB);
    await reserveOrderInventory(admin,orderId);

    const handoff=await pool.query(
      `select participant_actor_id,status,fulfillment_plan_id
         from network_handoffs
        where service_case_id=$1 and handoff_type='parts'
          and reference_type='parts_order' and reference_id=$2`,
      [caseId,orderId]
    );
    expect(handoff.rows[0].participant_actor_id).toBe(supplierB);
    expect(handoff.rows[0].status).toBe('in_progress');
    expect(handoff.rows[0].fulfillment_plan_id).toBe(planId);

    const stillRecovering=await pool.query(
      `select status,recovery_required_at from fulfillment_plans where id=$1`,
      [planId]
    );
    expect(stillRecovering.rows[0].status).toBe('blocked');
    expect(stillRecovering.rows[0].recovery_required_at).toBeTruthy();
  });

  it('reassigns mobility after provider failure and releases the failed resource',async()=>{
    const caseId=await createCase();
    const planId=await createPlan(caseId);
    const providerA=(await pool.query(`insert into actors(actor_type,status) values('fleet','active') returning id`)).rows[0].id as string;
    const providerB=(await pool.query(`insert into actors(actor_type,status) values('fleet','active') returning id`)).rows[0].id as string;

    const resourceA=await createMobilityResource(admin,{actorId:providerA,resourceType:'loaner',label:'Recovery A'});
    const resourceB=await createMobilityResource(admin,{actorId:providerB,resourceType:'loaner',label:'Recovery B'});
    const allocation=await requestMobility(admin,caseId,{allocationType:'loaner'});
    await assignMobility(admin,allocation!.id,{providerActorId:providerA,resourceId:resourceA.id});
    await updateMobilityState(admin,allocation!.id,'failed');

    const released=await pool.query(`select status from mobility_resources where id=$1`,[resourceA.id]);
    expect(released.rows[0].status).toBe('available');

    const failedPlan=await pool.query(
      `select status,recovery_required_at,recovery_reason from fulfillment_plans where id=$1`,
      [planId]
    );
    expect(failedPlan.rows[0].status).toBe('blocked');
    expect(failedPlan.rows[0].recovery_reason).toBe('mobility_failed');

    const reassigned=await assignMobility(admin,allocation!.id,{providerActorId:providerB,resourceId:resourceB.id});
    expect(reassigned!.state).toBe('assigned');
    expect(reassigned!.provider_actor_id).toBe(providerB);
    expect(reassigned!.resource_id).toBe(resourceB.id);

    const handoff=await pool.query(
      `select participant_actor_id,status,fulfillment_plan_id
         from network_handoffs
        where service_case_id=$1 and handoff_type='mobility'
          and reference_type='mobility_allocation' and reference_id=$2`,
      [caseId,allocation!.id]
    );
    expect(handoff.rows[0].participant_actor_id).toBe(providerB);
    expect(handoff.rows[0].status).toBe('assigned');
    expect(handoff.rows[0].fulfillment_plan_id).toBe(planId);

    const stillRecovering=await pool.query(
      `select status,recovery_required_at from fulfillment_plans where id=$1`,
      [planId]
    );
    expect(stillRecovering.rows[0].status).toBe('blocked');
    expect(stillRecovering.rows[0].recovery_required_at).toBeTruthy();
  });

  it('reassigns transport after runtime failure without losing recovery provenance',async()=>{
    const caseId=await createCase('triage');
    const planId=await createPlan(caseId);
    const towA=(await pool.query(`insert into actors(actor_type,status) values('tow','active') returning id`)).rows[0].id as string;
    const towB=(await pool.query(`insert into actors(actor_type,status) values('tow','active') returning id`)).rows[0].id as string;

    const dispatch=await createTransportDispatch(admin,{
      caseId,
      transportType:'tow',
      pickupLocation:{lat:45.52,lng:-122.68},
      dropoffLocation:{lat:45.53,lng:-122.67}
    });
    await assignTransportDispatch(admin,dispatch.id,towA);
    await updateTransportStatus({role:'tow',actorId:towA},dispatch.id,'accepted');
    await updateTransportStatus({role:'tow',actorId:towA},dispatch.id,'failed');

    const failed=await pool.query(
      `select status,recovery_required_at,recovery_reason from fulfillment_plans where id=$1`,
      [planId]
    );
    expect(failed.rows[0].status).toBe('blocked');
    expect(failed.rows[0].recovery_reason).toBe('transport_failed');

    const reassigned=await assignTransportDispatch(admin,dispatch.id,towB);
    expect(reassigned.status).toBe('assigned');
    expect(reassigned.provider_actor_id).toBe(towB);

    const owner=await pool.query(`select current_owner_actor_id from service_cases where id=$1`,[caseId]);
    expect(owner.rows[0].current_owner_actor_id).toBe(towB);

    const handoff=await pool.query(
      `select participant_actor_id,status,fulfillment_plan_id
         from network_handoffs
        where service_case_id=$1 and handoff_type='transport'
          and reference_type='transport_dispatch' and reference_id=$2`,
      [caseId,dispatch.id]
    );
    expect(handoff.rows[0].participant_actor_id).toBe(towB);
    expect(handoff.rows[0].status).toBe('assigned');
    expect(handoff.rows[0].fulfillment_plan_id).toBe(planId);

    const stillRecovering=await pool.query(
      `select status,recovery_required_at from fulfillment_plans where id=$1`,
      [planId]
    );
    expect(stillRecovering.rows[0].status).toBe('blocked');
    expect(stillRecovering.rows[0].recovery_required_at).toBeTruthy();
  });
});
