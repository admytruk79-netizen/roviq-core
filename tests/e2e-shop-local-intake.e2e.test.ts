import {createShopOsAppointment} from '../src/services/shop-os-appointment-create.js';
import {afterAll,describe,expect,it} from 'vitest';
import {pool} from '../src/db/pool.js';
import {createLocalShopIntake,listLocalShopIntake} from '../src/services/shop-os-local-intake.js';
import {createRepairOrder,getRepairOrder} from '../src/services/shop-os-repair-orders.js';
async function shop(){
  const org=(await pool.query("insert into organizations(organization_type,display_name) values('shop','Local intake test') returning id")).rows[0];
  const actor=(await pool.query("insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id",[org.id])).rows[0];
  return {orgId:org.id,principal:{role:'partner' as const,actorId:actor.id}};
}
describe('standalone shop intake',()=>{
  afterAll(async()=>{await pool.end()});
  it('links direct work to durable customer/vehicle records and blocks foreign context',async()=>{
    const a=await shop(),b=await shop();
    const local=await createLocalShopIntake(a.principal,{displayName:'Local customer',vehicle:{make:'Ford',model:'Focus'}});
    const other=await createLocalShopIntake(a.principal,{displayName:'Other customer',vehicle:{make:'Honda',model:'Civic'}});
    const connection=(await pool.query("insert into partner_system_connections(organization_id,mode,provider_key,display_name,connection_status) values($1,'roviq_native','roviq','Native test','active') returning id",[a.orgId])).rows[0];
    const resource=(await pool.query("insert into service_resources(organization_id,resource_type,display_name,active,source_connection_id) values($1,'bay','Intake bay',true,$2) returning id",[a.orgId,connection.id])).rows[0];
    await pool.query("insert into capacity_windows(organization_id,source_connection_id,resource_id,service_category,window_start,window_end,capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state) values($1,$2,$3,'repair',now(),now()+interval '3 hours','available',1,1,'roviq_native','current')",[a.orgId,connection.id,resource.id]);
    const appointment=await createShopOsAppointment(a.principal,{resourceId:resource.id,startsAt:new Date(Date.now()+600000).toISOString(),endsAt:new Date(Date.now()+1200000).toISOString(),serviceCategory:'repair',shopCustomerId:local.customer.id,shopVehicleId:local.vehicle.id});
    const linked=await createRepairOrder(a.principal,{appointmentId:appointment.id});
    expect(linked.shop_customer_id).toBe(local.customer.id);
    expect(linked.shop_vehicle_id).toBe(local.vehicle.id);
    const order=await createRepairOrder(a.principal,{shopCustomerId:local.customer.id,shopVehicleId:local.vehicle.id,customerConcern:'Brake inspection'});
    expect(order.service_case_id).toBeNull();
    const detail=await getRepairOrder(a.principal,order.id);
    expect(detail.customer.display_name).toBe('Local customer');
    expect(detail.vehicle.model).toBe('Focus');
    expect((await listLocalShopIntake(b.principal,{})).customers).toHaveLength(0);
    await expect(createRepairOrder(b.principal,{shopCustomerId:local.customer.id})).rejects.toMatchObject({statusCode:404});
    await expect(createRepairOrder(a.principal,{shopCustomerId:local.customer.id,shopVehicleId:other.vehicle.id})).rejects.toMatchObject({message:'shop_vehicle_not_found'});
    await expect(createRepairOrder(a.principal,{shopVehicleId:local.vehicle.id})).rejects.toMatchObject({message:'shop_customer_required'});
    // Database integrity also rejects writes bypassing the service boundary.
    await expect(pool.query('update shop_repair_orders set shop_vehicle_id=$2 where id=$1',[order.id,other.vehicle.id])).rejects.toMatchObject({code:'23503'});
    await expect(pool.query('update shop_repair_orders set organization_id=$2 where id=$1',[order.id,b.orgId])).rejects.toMatchObject({code:'23503'});
  });
});
