import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopOsAppointment, updateShopOsAppointment } from '../src/services/shop-os.js';
import { createRepairOrder, addRepairOrderLine, updateRepairOrderLine, updateRepairOrder } from '../src/services/shop-os-repair-orders.js';
import { createShopResource } from '../src/services/shop-os-resources.js';
import { createWorkItem, clockTechnicianIn } from '../src/services/shop-os-floor.js';

const admin={role:'admin'} as const;

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Review ${Date.now()}-${Math.random()}`
  ]);
  const connection=await pool.query(`insert into partner_system_connections(
    organization_id,mode,provider_key,display_name,connection_status
  ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const shopActor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  const resource=await pool.query(`insert into service_resources(
    organization_id,resource_type,display_name,active,source_connection_id,operational_state
  ) values($1,'bay','Bay 1',true,$2,'available') returning id`,[org.rows[0].id,connection.rows[0].id]);
  await pool.query(`insert into capacity_windows(
    organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
    capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
  ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '8 hours',
    'available',1,1,'roviq_native','current')`,[org.rows[0].id,connection.rows[0].id,resource.rows[0].id]);
  return {orgId:org.rows[0].id as string,connectionId:connection.rows[0].id as string,shopActorId:shopActor.rows[0].id as string,resourceId:resource.rows[0].id as string};
}

async function createCase(shopActorId:string,customerActorId?:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state,customer_actor_id)
    values($1,'maintenance','provider_selection',$2) returning id`,[domain.rows[0].id,customerActorId??null]);
  await pool.query(`update service_cases set current_owner_role='partner',current_owner_actor_id=$2 where id=$1`,[created.rows[0].id,shopActorId]);
  return created.rows[0].id as string;
}

async function createActiveOrder(input:{orgId:string;shopActorId:string;technicianActorId:string}){
  const caseId=await createCase(input.shopActorId);
  const order=await createRepairOrder(admin,{organizationId:input.orgId,serviceCaseId:caseId,primaryTechnicianActorId:input.technicianActorId});
  const line=await addRepairOrderLine(admin,order.id,{lineType:'labor',description:'Approved work',quantity:1,unitPrice:200,laborHours:1});
  await updateRepairOrder(admin,order.id,{action:'submit_estimate'});
  await updateRepairOrderLine(admin,order.id,line.line.id,{approvalStatus:'approved'});
  await updateRepairOrder(admin,order.id,{action:'approve'});
  await updateRepairOrder(admin,order.id,{action:'start'});
  return {repairOrderId:order.id as string,lineId:line.line.id as string};
}

describe('Shop OS Devin review hardening',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('keeps held appointments available but fails closed when case constraints block confirmation',async()=>{
    const shop=await setupShop();
    const caseId=await createCase(shop.shopActorId);
    await pool.query(`insert into case_parts_requirements(service_case_id,description,quantity,readiness_status)
      values($1,'Brake pads',1,'ordered')`,[caseId]);
    const start=new Date(Date.now()+30*60_000).toISOString();
    const end=new Date(Date.now()+90*60_000).toISOString();

    await expect(createShopOsAppointment(admin,{
      serviceCaseId:caseId,resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'
    })).rejects.toMatchObject({message:'service_case_not_confirmable',statusCode:409});

    const held=await createShopOsAppointment(admin,{
      serviceCaseId:caseId,resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'held'
    });
    expect(held.appointment_status).toBe('held');
    await expect(updateShopOsAppointment(admin,held.id,{action:'confirm'}))
      .rejects.toMatchObject({message:'service_case_not_confirmable',statusCode:409});
  });

  it('does not write appointments through blocked resources or paused Shop OS connections',async()=>{
    const blocked=await setupShop();
    await pool.query(`update service_resources set operational_state='blocked' where id=$1`,[blocked.resourceId]);
    const start=new Date(Date.now()+30*60_000).toISOString();
    const end=new Date(Date.now()+90*60_000).toISOString();
    await expect(createShopOsAppointment(admin,{resourceId:blocked.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair'}))
      .rejects.toMatchObject({message:'shop_os_resource_not_found',statusCode:404});

    const paused=await setupShop();
    await pool.query(`update partner_system_connections set connection_status='paused' where id=$1`,[paused.connectionId]);
    await expect(createShopOsAppointment(admin,{resourceId:paused.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair'}))
      .rejects.toMatchObject({message:'shop_os_resource_not_found',statusCode:404});
  });

  it('rejects attaching a different customer vehicle to a repair order',async()=>{
    const shop=await setupShop();
    const customerA=await pool.query(`insert into actors(actor_type,status) values('customer','active') returning id`);
    const customerB=await pool.query(`insert into actors(actor_type,status) values('customer','active') returning id`);
    const caseId=await createCase(shop.shopActorId,customerA.rows[0].id);
    const vehicle=await pool.query(`insert into customer_vehicles(customer_actor_id,vin,make,model)
      values($1,$2,'Toyota','Camry') returning id`,[customerB.rows[0].id,`VIN${Date.now()}${Math.floor(Math.random()*10000)}`]);

    await expect(createRepairOrder(admin,{organizationId:shop.orgId,serviceCaseId:caseId,customerVehicleId:vehicle.rows[0].id}))
      .rejects.toMatchObject({message:'repair_order_vehicle_customer_mismatch',statusCode:409});
  });

  it('cancels active WIP, closes technician clocks, records audit events and releases the technician',async()=>{
    const shop=await setupShop();
    const technician=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[shop.orgId]);
    const technicianResource=await createShopResource(admin,{
      organizationId:shop.orgId,resourceType:'technician',displayName:'Tech A',assignedActorId:technician.rows[0].id
    });
    const firstOrder=await createActiveOrder({orgId:shop.orgId,shopActorId:shop.shopActorId,technicianActorId:technician.rows[0].id});
    const firstWork=await createWorkItem(admin,{
      repairOrderId:firstOrder.repairOrderId,repairOrderLineId:firstOrder.lineId,title:'First job',
      technicianActorId:technician.rows[0].id,technicianResourceId:technicianResource.id
    });
    const firstClock=await clockTechnicianIn(admin,firstWork.id,{});
    await updateRepairOrder(admin,firstOrder.repairOrderId,{action:'cancel'});

    const work=await pool.query(`select status,blocked_reason from shop_work_items where id=$1`,[firstWork.id]);
    expect(work.rows[0].status).toBe('cancelled');
    const time=await pool.query(`select ended_at,end_reason from shop_technician_time_entries where id=$1`,[firstClock.id]);
    expect(time.rows[0].ended_at).toBeTruthy();
    expect(time.rows[0].end_reason).toBe('order_cancelled');
    const audit=await pool.query(`select event_type from events where aggregate_id in ($1,$2)`,[firstWork.id,firstClock.id]);
    expect(audit.rows.map((row)=>row.event_type)).toContain('SHOP_OS_WORK_ITEM_CANCELLED_BY_ORDER');
    expect(audit.rows.map((row)=>row.event_type)).toContain('SHOP_OS_TECHNICIAN_TIME_AUTO_CLOSED');

    const secondOrder=await createActiveOrder({orgId:shop.orgId,shopActorId:shop.shopActorId,technicianActorId:technician.rows[0].id});
    const secondWork=await createWorkItem(admin,{
      repairOrderId:secondOrder.repairOrderId,repairOrderLineId:secondOrder.lineId,title:'Second job',
      technicianActorId:technician.rows[0].id,technicianResourceId:technicianResource.id
    });
    expect((await clockTechnicianIn(admin,secondWork.id,{})).id).toBeTruthy();
  });
});
