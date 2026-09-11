import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopOsAppointment } from '../src/services/shop-os-appointment-create.js';
import { updateDeferredService, deferRepairOrderLine } from '../src/services/shop-os-completion.js';
import { addRepairOrderLine, createRepairOrder, updateRepairOrder, updateRepairOrderLine } from '../src/services/shop-os-repair-orders.js';
import { updateShopResource } from '../src/services/shop-os-resources.js';

const admin={role:'admin'} as const;

async function setupNativeShop(nominalCapacityUnits=1){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Concurrency ${Date.now()}-${Math.random()}`
  ]);
  const connection=await pool.query(`insert into partner_system_connections(
      organization_id,mode,provider_key,display_name,connection_status
    ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const resource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id,operational_state
    ) values($1,'bay','Bay 1',true,$2,'available') returning id`,[org.rows[0].id,connection.rows[0].id]);
  await pool.query(`insert into capacity_windows(
      organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
      capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
    ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '3 hours',
      'available',$4,$4,'roviq_native','current')`,[
    org.rows[0].id,connection.rows[0].id,resource.rows[0].id,nominalCapacityUnits
  ]);
  return {
    orgId:org.rows[0].id as string,
    connectionId:connection.rows[0].id as string,
    resourceId:resource.rows[0].id as string
  };
}

async function setupDeferredBookingRace(){
  const shop=await setupNativeShop(1);
  const shopActor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[shop.orgId]);
  const customer=await pool.query(`insert into actors(actor_type,status) values('customer','active') returning id`);
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const serviceCase=await pool.query(`insert into service_cases(domain_id,case_type,state,customer_actor_id,current_owner_role,current_owner_actor_id)
    values($1,'maintenance','provider_selection',$2,'partner',$3) returning id`,[
    domain.rows[0].id,customer.rows[0].id,shopActor.rows[0].id
  ]);
  const caseId=serviceCase.rows[0].id as string;
  const order=await createRepairOrder(admin,{organizationId:shop.orgId,serviceCaseId:caseId,customerConcern:'Brake service'});
  const deferredLine=await addRepairOrderLine(admin,order.id,{
    lineType:'labor',description:'Rear brake service',serviceCategory:'brakes',quantity:1,unitPrice:300,unitCost:80,laborHours:1.5
  });
  await updateRepairOrder(admin,order.id,{action:'submit_estimate'});
  await updateRepairOrderLine(admin,order.id,deferredLine.line.id,{approvalStatus:'deferred'});
  await updateRepairOrder(admin,order.id,{action:'approve'});
  const deferred=await deferRepairOrderLine(admin,{
    repairOrderId:order.id,repairOrderLineId:deferredLine.line.id,severity:'attention',reason:'Customer postponed repair'
  });
  const start=new Date(Date.now()+30*60_000).toISOString();
  const end=new Date(Date.now()+90*60_000).toISOString();
  const appointment=await pool.query(`insert into roviq_appointments(
      service_case_id,organization_id,resource_id,source_connection_id,appointment_status,starts_at,ends_at,service_category
    ) values($1,$2,$3,$4,'held',$5,$6,'brakes') returning id`,[
    caseId,shop.orgId,shop.resourceId,shop.connectionId,start,end
  ]);
  return {
    ...shop,
    caseId,
    repairOrderId:order.id as string,
    lineId:deferredLine.line.id as string,
    deferredItemId:deferred.id as string,
    appointmentId:appointment.rows[0].id as string
  };
}

function isDeadlock(result:PromiseSettledResult<unknown>){
  if(result.status!=='rejected') return false;
  const reason=result.reason as {code?:string;message?:string}|undefined;
  return reason?.code==='40P01'||reason?.message?.toLowerCase().includes('deadlock')===true;
}

describe('Shop OS real PostgreSQL concurrency invariants',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('serializes concurrent bookings against one unit of capacity',async()=>{
    const {resourceId}=await setupNativeShop(1);
    const start=new Date(Date.now()+20*60_000).toISOString();
    const end=new Date(Date.now()+80*60_000).toISOString();

    const results=await Promise.allSettled([
      createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'}),
      createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'})
    ]);

    const fulfilled=results.filter((result)=>result.status==='fulfilled');
    const rejected=results.filter((result)=>result.status==='rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({message:'shop_os_capacity_unavailable',statusCode:409});

    const active=await pool.query(`select count(*)::int as n from roviq_appointments
      where resource_id=$1 and appointment_status in ('held','confirmed','in_progress')
        and starts_at<$3::timestamptz and ends_at>$2::timestamptz`,[resourceId,start,end]);
    expect(Number(active.rows[0].n)).toBe(1);
  });

  it('serializes resource deactivation against booking without creating an unusable active appointment',async()=>{
    const {resourceId}=await setupNativeShop(1);
    const start=new Date(Date.now()+25*60_000).toISOString();
    const end=new Date(Date.now()+85*60_000).toISOString();

    const results=await Promise.allSettled([
      createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'}),
      updateShopResource(admin,resourceId,{active:false})
    ]);

    expect(results.some(isDeadlock)).toBe(false);
    const resource=await pool.query(`select active from service_resources where id=$1`,[resourceId]);
    const activeAppointments=await pool.query(`select count(*)::int as n from roviq_appointments
      where resource_id=$1 and appointment_status in ('held','confirmed','in_progress')`,[resourceId]);
    const activeCount=Number(activeAppointments.rows[0].n);

    // Either booking wins and deactivation fails, or deactivation wins and booking fails closed.
    expect(resource.rows[0].active===true||activeCount===0).toBe(true);
    if(resource.rows[0].active===false) expect(activeCount).toBe(0);
  });

  it('does not deadlock deferred booking against a concurrent repair-line approval change',async()=>{
    const race=await setupDeferredBookingRace();

    const results=await Promise.allSettled([
      updateDeferredService(admin,race.deferredItemId,{action:'book',appointmentId:race.appointmentId}),
      updateRepairOrderLine(admin,race.repairOrderId,race.lineId,{approvalStatus:'approved'})
    ]);

    expect(results.some(isDeadlock)).toBe(false);
    expect(results[1].status).toBe('fulfilled');
    if(results[0].status==='rejected'){
      expect(results[0].reason).toMatchObject({message:'deferred_service_transition_invalid',statusCode:409});
    }

    const line=await pool.query(`select approval_status from shop_repair_order_lines where id=$1`,[race.lineId]);
    const deferred=await pool.query(`select status,booked_appointment_id from shop_deferred_service_items where id=$1`,[race.deferredItemId]);
    expect(line.rows[0].approval_status).toBe('approved');
    expect(deferred.rows[0].status).toBe('dismissed');
  });
});
