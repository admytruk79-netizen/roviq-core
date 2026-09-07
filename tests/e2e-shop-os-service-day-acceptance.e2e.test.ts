import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopResource } from '../src/services/shop-os-resources.js';
import { addRepairOrderLine, createRepairOrder, updateRepairOrder, updateRepairOrderLine } from '../src/services/shop-os-repair-orders.js';
import {
  addDviFinding, clockTechnicianIn, clockTechnicianOut, createDviInspection,
  createWorkItem, getShopFloor, submitDviInspection, updateWorkItem
} from '../src/services/shop-os-floor.js';
import {
  createRepairOrderPartRequirement, reconcileRepairOrder, updateRepairOrderPartRequirement
} from '../src/services/shop-os-completion.js';

const admin={role:'admin'} as const;

async function setupServiceDay(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Service Day ${Date.now()}-${Math.random()}`
  ]);
  await pool.query(`insert into partner_system_connections(
      organization_id,mode,provider_key,display_name,connection_status
    ) values($1,'roviq_native','roviq','Shop OS Native','active')`,[org.rows[0].id]);
  const shopActor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  const technician=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[org.rows[0].id]);
  const customer=await pool.query(`insert into actors(actor_type,status) values('customer','active') returning id`);
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const serviceCase=await pool.query(`insert into service_cases(domain_id,case_type,state,customer_actor_id,current_owner_role,current_owner_actor_id)
    values($1,'maintenance','provider_selection',$2,'partner',$3) returning id`,[
      domain.rows[0].id,customer.rows[0].id,shopActor.rows[0].id
    ]);
  const technicianResource=await createShopResource(admin,{
    organizationId:org.rows[0].id,resourceType:'technician',displayName:'Service Tech',assignedActorId:technician.rows[0].id,capabilityTags:['maintenance']
  });
  const bay=await createShopResource(admin,{
    organizationId:org.rows[0].id,resourceType:'bay',displayName:'Bay 1',capabilityTags:['maintenance']
  });
  return {
    orgId:org.rows[0].id as string,
    shopActorId:shopActor.rows[0].id as string,
    technicianActorId:technician.rows[0].id as string,
    caseId:serviceCase.rows[0].id as string,
    technicianResourceId:technicianResource.id as string,
    bayResourceId:bay.id as string
  };
}

describe('Shop OS full service-day acceptance',()=>{
  afterAll(async()=>{await pool.end();});

  it('runs estimate, DVI, approval, parts, technician time, QC, completion and reconciliation as one durable repair flow',async()=>{
    const shop=await setupServiceDay();
    const order=await createRepairOrder(admin,{
      organizationId:shop.orgId,
      serviceCaseId:shop.caseId,
      primaryTechnicianActorId:shop.technicianActorId,
      customerConcern:'Brake vibration and grinding noise'
    });
    const labor=await addRepairOrderLine(admin,order.id,{
      lineType:'labor',description:'Front brake service',quantity:1,unitPrice:240,unitCost:80,laborHours:1.5
    });
    const part=await addRepairOrderLine(admin,order.id,{
      lineType:'part',description:'Front brake pads',quantity:1,unitPrice:140,unitCost:70
    });

    expect((await updateRepairOrder(admin,order.id,{action:'submit_estimate'})).status).toBe('awaiting_approval');
    await updateRepairOrderLine(admin,order.id,labor.line.id,{approvalStatus:'approved'});
    await updateRepairOrderLine(admin,order.id,part.line.id,{approvalStatus:'approved'});
    expect((await updateRepairOrder(admin,order.id,{action:'approve'})).status).toBe('approved');

    const inspection=await createDviInspection(admin,{
      repairOrderId:order.id,technicianActorId:shop.technicianActorId,inspectionType:'multipoint'
    });
    await addDviFinding(admin,inspection.id,{
      section:'Brakes',item:'Front brake pad thickness',severity:'urgent',repairOrderLineId:part.line.id,
      measurement:'2 mm',technicianNote:'Below service threshold',customerNote:'Replacement recommended now'
    });
    expect((await submitDviInspection(admin,inspection.id)).status).toBe('submitted');

    const requirement=await createRepairOrderPartRequirement(admin,{
      repairOrderId:order.id,repairOrderLineId:part.line.id,partReference:'PAD-FRONT',description:'Front brake pad set'
    });
    await updateRepairOrderPartRequirement(admin,requirement.id,{readinessStatus:'ordered'});
    await updateRepairOrderPartRequirement(admin,requirement.id,{readinessStatus:'received'});
    await updateRepairOrderPartRequirement(admin,requirement.id,{readinessStatus:'ready'});

    expect((await updateRepairOrder(admin,order.id,{action:'start'})).status).toBe('in_progress');
    const work=await createWorkItem(admin,{
      repairOrderId:order.id,repairOrderLineId:labor.line.id,title:'Replace front brake pads',
      technicianActorId:shop.technicianActorId,technicianResourceId:shop.technicianResourceId,
      bayResourceId:shop.bayResourceId,estimatedMinutes:90
    });
    const clock=await clockTechnicianIn(admin,work.id,{});
    expect(clock.ended_at).toBeNull();
    await clockTechnicianOut(admin,work.id,{endReason:'complete'});
    expect((await updateWorkItem(admin,work.id,{action:'qc'})).status).toBe('quality_control');
    expect((await updateWorkItem(admin,work.id,{action:'complete'})).status).toBe('completed');

    expect((await updateRepairOrder(admin,order.id,{action:'qc'})).status).toBe('quality_control');
    expect((await updateRepairOrder(admin,order.id,{action:'complete'})).status).toBe('completed');

    const floor=await getShopFloor(admin,order.id);
    expect(floor.summary.submittedInspections).toBe(1);
    expect(floor.summary.urgentFindings).toBe(1);
    expect(floor.summary.openWorkItems).toBe(0);
    expect(floor.summary.activeClocks).toBe(0);

    const reconciliation=await reconcileRepairOrder(admin,order.id);
    expect(reconciliation.revenue).toBe(380);
    expect(reconciliation.ledgerEntries).toHaveLength(3);
    expect(reconciliation.contribution).toBeGreaterThanOrEqual(0);

    const events=await pool.query(`select event_type from events where aggregate_type='repair_order' and aggregate_id=$1`,[order.id]);
    const eventTypes=events.rows.map(row=>row.event_type);
    expect(eventTypes).toContain('SHOP_OS_DVI_SUBMITTED');
    expect(eventTypes).toContain('SHOP_OS_PART_READINESS_UPDATED');
    expect(eventTypes).toContain('SHOP_OS_TECHNICIAN_CLOCK_IN');
    expect(eventTypes).toContain('SHOP_OS_TECHNICIAN_CLOCK_OUT');
  });
});
