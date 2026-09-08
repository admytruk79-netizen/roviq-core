import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopResource, listShopResources, updateShopResource } from '../src/services/shop-os-resources.js';
import {
  addRepairOrderLine, createRepairOrder, getRepairOrder, listRepairOrders, updateRepairOrder, updateRepairOrderLine
} from '../src/services/shop-os-repair-orders.js';

const admin={role:'admin'} as const;

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Fixed Ops ${Date.now()}-${Math.random()}`
  ]);
  const connection=await pool.query(`insert into partner_system_connections(
    organization_id,mode,provider_key,display_name,connection_status
  ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  return {orgId:org.rows[0].id as string,connectionId:connection.rows[0].id as string,actorId:actor.rows[0].id as string};
}

async function createLinkedCase(actorId:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state,current_owner_role,current_owner_actor_id)
    values($1,'maintenance','provider_selection','partner',$2) returning id`,[domain.rows[0].id,actorId]);
  await pool.query(`update service_cases set current_owner_role='partner',current_owner_actor_id=$2 where id=$1`,[created.rows[0].id,actorId]);
  return created.rows[0].id as string;
}

describe('Shop OS fixed operations',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('manages native shop resources with tenant-safe actor assignment',async()=>{
    const shop=await setupShop();
    const technician=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[shop.orgId]);
    const resource=await createShopResource(admin,{
      organizationId:shop.orgId,resourceType:'technician',displayName:'Tech A',assignedActorId:technician.rows[0].id,
      capabilityTags:['brakes','diagnostics'],hourlyCost:42,laborRate:155
    });
    expect(resource.resource_type).toBe('technician');
    expect(resource.assigned_actor_id).toBe(technician.rows[0].id);
    expect(resource.operational_state).toBe('available');

    const updated=await updateShopResource(admin,resource.id,{operationalState:'busy',laborRate:165});
    expect(updated.operational_state).toBe('busy');
    expect(Number(updated.labor_rate)).toBe(165);

    const listed=await listShopResources(admin,{organizationId:shop.orgId,resourceType:'technician'});
    expect(listed.resources.some((item)=>item.id===resource.id)).toBe(true);

    const foreign=await setupShop();
    const foreignActor=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[foreign.orgId]);
    await expect(updateShopResource(admin,resource.id,{assignedActorId:foreignActor.rows[0].id}))
      .rejects.toMatchObject({message:'resource_actor_tenant_mismatch',statusCode:409});
  });

  it('runs a repair order from estimate through closed with line approvals and totals',async()=>{
    const shop=await setupShop();
    const caseId=await createLinkedCase(shop.actorId);
    const order=await createRepairOrder(admin,{organizationId:shop.orgId,serviceCaseId:caseId,customerConcern:'Brake vibration'});
    expect(order.status).toBe('draft');
    expect(order.repair_order_number).toMatch(/^RO-/);

    const labor=await addRepairOrderLine(admin,order.id,{
      lineType:'labor',description:'Front brake service',quantity:2,unitPrice:150,unitCost:70,laborHours:2
    });
    const part=await addRepairOrderLine(admin,order.id,{
      lineType:'part',description:'Front pad set',quantity:1,unitPrice:120,unitCost:65
    });
    expect(Number(part.repairOrder.subtotal_amount)).toBe(420);

    const submitted=await updateRepairOrder(admin,order.id,{action:'submit_estimate'});
    expect(submitted.status).toBe('awaiting_approval');

    await updateRepairOrderLine(admin,order.id,labor.line.id,{approvalStatus:'approved'});
    await updateRepairOrderLine(admin,order.id,part.line.id,{approvalStatus:'deferred'});
    const approved=await updateRepairOrder(admin,order.id,{action:'approve'});
    expect(approved.status).toBe('approved');
    expect(Number(approved.approved_amount)).toBe(300);

    expect((await updateRepairOrder(admin,order.id,{action:'start'})).status).toBe('in_progress');
    expect((await updateRepairOrder(admin,order.id,{action:'qc'})).status).toBe('quality_control');
    expect((await updateRepairOrder(admin,order.id,{action:'complete'})).status).toBe('completed');
    expect((await updateRepairOrder(admin,order.id,{action:'close'})).status).toBe('closed');

    const loaded=await getRepairOrder(admin,order.id);
    expect(loaded.lines).toHaveLength(2);
    expect(loaded.repairOrder.closed_at).toBeTruthy();
  });

  it('blocks cross-tenant case attachment and keeps repair order reads tenant scoped',async()=>{
    const shopA=await setupShop();
    const shopB=await setupShop();
    const caseB=await createLinkedCase(shopB.actorId);

    await expect(createRepairOrder(admin,{organizationId:shopA.orgId,serviceCaseId:caseB}))
      .rejects.toMatchObject({message:'service_case_tenant_mismatch',statusCode:409});

    const orderB=await createRepairOrder(admin,{organizationId:shopB.orgId,serviceCaseId:caseB});
    const partnerA={role:'partner',actorId:shopA.actorId} as const;
    await expect(getRepairOrder(partnerA,orderB.id)).rejects.toMatchObject({message:'forbidden',statusCode:403});
    await expect(listRepairOrders(partnerA,{organizationId:shopB.orgId})).rejects.toMatchObject({message:'forbidden',statusCode:403});
  });
});
