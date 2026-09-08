import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopResource } from '../src/services/shop-os-resources.js';
import { addRepairOrderLine, createRepairOrder, updateRepairOrder, updateRepairOrderLine } from '../src/services/shop-os-repair-orders.js';
import {
  addDviEvidence, addDviFinding, clockTechnicianIn, clockTechnicianOut, createDviInspection,
  createWorkItem, getShopFloor, submitDviInspection, updateWorkItem
} from '../src/services/shop-os-floor.js';

const admin={role:'admin'} as const;

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Floor ${Date.now()}-${Math.random()}`
  ]);
  const connection=await pool.query(`insert into partner_system_connections(
    organization_id,mode,provider_key,display_name,connection_status
  ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  const technician=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[org.rows[0].id]);
  return {
    orgId:org.rows[0].id as string,connectionId:connection.rows[0].id as string,
    actorId:actor.rows[0].id as string,technicianActorId:technician.rows[0].id as string
  };
}

async function createLinkedCase(actorId:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state) values($1,'maintenance','provider_selection') returning id`,[domain.rows[0].id]);
  await pool.query(`update service_cases set current_owner_role='partner',current_owner_actor_id=$2 where id=$1`,[created.rows[0].id,actorId]);
  return created.rows[0].id as string;
}

async function setupActiveRepairOrder(){
  const shop=await setupShop();
  const caseId=await createLinkedCase(shop.actorId);
  const order=await createRepairOrder(admin,{
    organizationId:shop.orgId,serviceCaseId:caseId,primaryTechnicianActorId:shop.technicianActorId,customerConcern:'Brake vibration'
  });
  const labor=await addRepairOrderLine(admin,order.id,{
    lineType:'labor',description:'Front brake service',quantity:1,unitPrice:300,unitCost:120,laborHours:2
  });
  await updateRepairOrder(admin,order.id,{action:'submit_estimate'});
  await updateRepairOrderLine(admin,order.id,labor.line.id,{approvalStatus:'approved'});
  await updateRepairOrder(admin,order.id,{action:'approve'});
  await updateRepairOrder(admin,order.id,{action:'start'});
  const technicianResource=await createShopResource(admin,{
    organizationId:shop.orgId,resourceType:'technician',displayName:'Tech A',assignedActorId:shop.technicianActorId,capabilityTags:['brakes']
  });
  const bay=await createShopResource(admin,{organizationId:shop.orgId,resourceType:'bay',displayName:'Bay 1',capabilityTags:['repair']});
  return {...shop,caseId,repairOrderId:order.id as string,lineId:labor.line.id as string,technicianResourceId:technicianResource.id as string,bayResourceId:bay.id as string};
}

describe('Shop OS DVI, WIP and technician time',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('runs inspection evidence, work execution and technician time through one repair order',async()=>{
    const shop=await setupActiveRepairOrder();
    const inspection=await createDviInspection(admin,{
      repairOrderId:shop.repairOrderId,technicianActorId:shop.technicianActorId,inspectionType:'multipoint'
    });
    const finding=await addDviFinding(admin,inspection.id,{
      section:'Brakes',item:'Front pad thickness',severity:'urgent',repairOrderLineId:shop.lineId,measurement:'2 mm',
      technicianNote:'Below service threshold',customerNote:'Front pads require replacement'
    });
    const evidence=await addDviEvidence(admin,inspection.id,{
      findingId:finding.id,mediaType:'photo',storageKey:`dvi/${inspection.id}/front-pads.jpg`,mimeType:'image/jpeg',customerVisible:true
    });
    expect(evidence.finding_id).toBe(finding.id);
    expect((await submitDviInspection(admin,inspection.id)).status).toBe('submitted');

    const workItem=await createWorkItem(admin,{
      repairOrderId:shop.repairOrderId,repairOrderLineId:shop.lineId,title:'Replace front brake pads',
      technicianActorId:shop.technicianActorId,technicianResourceId:shop.technicianResourceId,bayResourceId:shop.bayResourceId,estimatedMinutes:120
    });
    expect(workItem.status).toBe('assigned');

    const firstClock=await clockTechnicianIn(admin,workItem.id,{});
    expect(firstClock.ended_at).toBeNull();
    await expect(clockTechnicianIn(admin,workItem.id,{})).rejects.toMatchObject({message:'technician_already_clocked_in',statusCode:409});

    const pausedClock=await clockTechnicianOut(admin,workItem.id,{endReason:'pause'});
    expect(pausedClock.ended_at).toBeTruthy();
    expect((await updateWorkItem(admin,workItem.id,{action:'resume'})).status).toBe('in_progress');
    const secondClock=await clockTechnicianIn(admin,workItem.id,{});
    expect(secondClock.id).not.toBe(firstClock.id);
    await clockTechnicianOut(admin,workItem.id,{endReason:'manual'});
    expect((await updateWorkItem(admin,workItem.id,{action:'qc'})).status).toBe('quality_control');
    expect((await updateWorkItem(admin,workItem.id,{action:'complete'})).status).toBe('completed');

    const floor=await getShopFloor(admin,shop.repairOrderId);
    expect(floor.inspections).toHaveLength(1);
    expect(floor.findings).toHaveLength(1);
    expect(floor.evidence).toHaveLength(1);
    expect(floor.workItems).toHaveLength(1);
    expect(floor.timeEntries).toHaveLength(2);
    expect(floor.summary.submittedInspections).toBe(1);
    expect(floor.summary.urgentFindings).toBe(1);
    expect(floor.summary.openWorkItems).toBe(0);
    expect(floor.summary.activeClocks).toBe(0);
  });

  it('prevents one technician from being clocked into two work items at once',async()=>{
    const shop=await setupActiveRepairOrder();
    const first=await createWorkItem(admin,{
      repairOrderId:shop.repairOrderId,repairOrderLineId:shop.lineId,title:'Approved brake work',technicianActorId:shop.technicianActorId,
      technicianResourceId:shop.technicianResourceId,bayResourceId:shop.bayResourceId
    });
    const second=await createWorkItem(admin,{
      repairOrderId:shop.repairOrderId,title:'Road-test verification',technicianActorId:shop.technicianActorId,
      technicianResourceId:shop.technicianResourceId
    });
    await clockTechnicianIn(admin,first.id,{});
    await expect(clockTechnicianIn(admin,second.id,{})).rejects.toMatchObject({message:'technician_already_clocked_in',statusCode:409});
    await clockTechnicianOut(admin,first.id,{endReason:'switch'});
    expect((await clockTechnicianIn(admin,second.id,{})).id).toBeTruthy();
  });

  it('keeps DVI and shop-floor state tenant isolated',async()=>{
    const shopA=await setupActiveRepairOrder();
    const shopB=await setupActiveRepairOrder();
    const partnerA={role:'partner',actorId:shopA.actorId} as const;
    await expect(getShopFloor(partnerA,shopB.repairOrderId)).rejects.toMatchObject({message:'forbidden',statusCode:403});

    const inspectionB=await createDviInspection(admin,{repairOrderId:shopB.repairOrderId,technicianActorId:shopB.technicianActorId});
    await expect(addDviFinding(partnerA,inspectionB.id,{section:'Tires',item:'Tread',severity:'good'}))
      .rejects.toMatchObject({message:'forbidden',statusCode:403});
  });
});
