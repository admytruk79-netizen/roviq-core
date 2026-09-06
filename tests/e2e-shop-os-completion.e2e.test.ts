import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { addRepairOrderLine, createRepairOrder, updateRepairOrder, updateRepairOrderLine } from '../src/services/shop-os-repair-orders.js';
import {
  createRepairOrderPartRequirement, deferRepairOrderLine, listDeferredService, reconcileRepairOrder,
  updateDeferredService, updateRepairOrderPartRequirement
} from '../src/services/shop-os-completion.js';

const admin={role:'admin'} as const;

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Completion ${Date.now()}-${Math.random()}`
  ]);
  const shopActor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  const customer=await pool.query(`insert into actors(actor_type,status) values('customer','active') returning id`);
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const serviceCase=await pool.query(`insert into service_cases(domain_id,case_type,state,customer_actor_id)
    values($1,'maintenance','provider_selection',$2) returning id`,[domain.rows[0].id,customer.rows[0].id]);
  await pool.query(`update service_cases set current_owner_role='partner',current_owner_actor_id=$2 where id=$1`,[serviceCase.rows[0].id,shopActor.rows[0].id]);
  return {orgId:org.rows[0].id as string,shopActorId:shopActor.rows[0].id as string,customerActorId:customer.rows[0].id as string,caseId:serviceCase.rows[0].id as string};
}

async function setupOrder(){
  const shop=await setupShop();
  const order=await createRepairOrder(admin,{organizationId:shop.orgId,serviceCaseId:shop.caseId,customerConcern:'Brake service'});
  const labor=await addRepairOrderLine(admin,order.id,{lineType:'labor',description:'Brake labor',quantity:1,unitPrice:200,unitCost:40,laborHours:1});
  const part=await addRepairOrderLine(admin,order.id,{lineType:'part',description:'Brake pads',quantity:1,unitPrice:100,unitCost:60});
  const deferred=await addRepairOrderLine(admin,order.id,{lineType:'labor',description:'Rear shocks',quantity:1,unitPrice:500,unitCost:180,laborHours:2});
  await updateRepairOrder(admin,order.id,{action:'submit_estimate'});
  await updateRepairOrderLine(admin,order.id,labor.line.id,{approvalStatus:'approved'});
  await updateRepairOrderLine(admin,order.id,part.line.id,{approvalStatus:'approved'});
  await updateRepairOrderLine(admin,order.id,deferred.line.id,{approvalStatus:'deferred'});
  await updateRepairOrder(admin,order.id,{action:'approve'});
  return {...shop,repairOrderId:order.id as string,laborLineId:labor.line.id as string,partLineId:part.line.id as string,deferredLineId:deferred.line.id as string};
}

describe('Shop OS parts readiness, deferred service and reconciliation',()=>{
  afterAll(async()=>{await pool.end();});

  it('projects repair-order part readiness into canonical case constraints',async()=>{
    const shop=await setupOrder();
    const requirement=await createRepairOrderPartRequirement(admin,{
      repairOrderId:shop.repairOrderId,repairOrderLineId:shop.partLineId,partReference:'PAD-001'
    });
    let constraint=await pool.query(`select status from case_constraints where service_case_id=$1 and projection_key='parts-readiness'`,[shop.caseId]);
    expect(constraint.rows[0].status).toBe('required');
    const ready=await updateRepairOrderPartRequirement(admin,requirement.id,{readinessStatus:'ready'});
    expect(ready.readiness_status).toBe('ready');
    constraint=await pool.query(`select status from case_constraints where service_case_id=$1 and projection_key='parts-readiness'`,[shop.caseId]);
    expect(constraint.rows[0].status).toBe('satisfied');
  });

  it('preserves deferred work as follow-up CRM and closes it when the line becomes approved',async()=>{
    const shop=await setupOrder();
    const deferred=await deferRepairOrderLine(admin,{
      repairOrderId:shop.repairOrderId,repairOrderLineId:shop.deferredLineId,severity:'attention',reason:'Customer postponed repair'
    });
    expect(deferred.status).toBe('open');
    const reminded=await updateDeferredService(admin,deferred.id,{action:'remind'});
    expect(reminded.status).toBe('reminded');
    expect(Number(reminded.follow_up_count)).toBe(1);
    const outbox=await pool.query(`select template_key,recipient_id from notification_outbox where case_id=$1 and template_key='deferred_service_reminder'`,[shop.caseId]);
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].recipient_id).toBe(shop.customerActorId);
    const listed=await listDeferredService(admin,{organizationId:shop.orgId,statuses:['reminded']});
    expect(listed.deferredItems.some((item)=>item.id===deferred.id)).toBe(true);

    await updateRepairOrderLine(admin,shop.repairOrderId,shop.deferredLineId,{approvalStatus:'approved'});
    let followUp=await pool.query(`select status,next_follow_up_at from shop_deferred_service_items where id=$1`,[deferred.id]);
    expect(followUp.rows[0].status).toBe('dismissed');
    expect(followUp.rows[0].next_follow_up_at).toBeNull();

    await updateRepairOrderLine(admin,shop.repairOrderId,shop.deferredLineId,{approvalStatus:'deferred'});
    followUp=await pool.query(`select status,dismissed_at from shop_deferred_service_items where id=$1`,[deferred.id]);
    expect(followUp.rows[0].status).toBe('open');
    expect(followUp.rows[0].dismissed_at).toBeNull();
  });

  it('refuses completion while parts are unresolved, then reconciles completed work idempotently',async()=>{
    const shop=await setupOrder();
    const requirement=await createRepairOrderPartRequirement(admin,{
      repairOrderId:shop.repairOrderId,repairOrderLineId:shop.partLineId,partReference:'PAD-002'
    });
    await updateRepairOrder(admin,shop.repairOrderId,{action:'start'});
    await updateRepairOrder(admin,shop.repairOrderId,{action:'qc'});
    await expect(updateRepairOrder(admin,shop.repairOrderId,{action:'complete'}))
      .rejects.toMatchObject({message:'repair_order_parts_unresolved',statusCode:409});
    const stillQc=await pool.query(`select status from shop_repair_orders where id=$1`,[shop.repairOrderId]);
    expect(stillQc.rows[0].status).toBe('quality_control');

    await updateRepairOrderPartRequirement(admin,requirement.id,{readinessStatus:'ready'});
    await updateRepairOrder(admin,shop.repairOrderId,{action:'complete'});
    const first=await reconcileRepairOrder(admin,shop.repairOrderId);
    expect(first.revenue).toBe(300);
    expect(first.directCost).toBe(60);
    expect(first.laborCost).toBe(40);
    expect(first.laborCostSource).toBe('repair_order_line_estimate');
    expect(first.contribution).toBe(200);
    expect(first.ledgerEntries).toHaveLength(3);
    const firstDates=first.ledgerEntries.map((entry)=>new Date(entry.occurred_at).toISOString());
    const second=await reconcileRepairOrder(admin,shop.repairOrderId);
    expect(second.ledgerEntries).toHaveLength(3);
    expect(second.ledgerEntries.map((entry)=>new Date(entry.occurred_at).toISOString())).toEqual(firstDates);
    const count=await pool.query(`select count(*)::int as n from ledger_entries where repair_order_id=$1 and reconciliation_key is not null`,[shop.repairOrderId]);
    expect(Number(count.rows[0].n)).toBe(3);
  });
});
