import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopOsAppointment, updateShopOsAppointment } from '../src/services/shop-os.js';

const admin={role:'admin'} as const;

async function setupNativeShop(nominalCapacityUnits=2){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Capacity ${Date.now()}-${Math.random()}`
  ]);
  const connection=await pool.query(`insert into partner_system_connections(
      organization_id,mode,provider_key,display_name,connection_status
    ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const resource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id
    ) values($1,'bay','Bay 1',true,$2) returning id`,[org.rows[0].id,connection.rows[0].id]);
  const window=await pool.query(`insert into capacity_windows(
      organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
      capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
    ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '2 hours',
      'available',$4,$4,'roviq_native','current') returning id`,[
    org.rows[0].id,connection.rows[0].id,resource.rows[0].id,nominalCapacityUnits
  ]);
  return {orgId:org.rows[0].id as string,connectionId:connection.rows[0].id as string,resourceId:resource.rows[0].id as string,windowId:window.rows[0].id as string};
}

async function createAdditionalResource(input:{orgId:string;connectionId:string;name:string;nominalCapacityUnits?:number}){
  const resource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id
    ) values($1,'bay',$2,true,$3) returning id`,[input.orgId,input.name,input.connectionId]);
  await pool.query(`insert into capacity_windows(
      organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
      capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
    ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '2 hours',
      'available',$4,$4,'roviq_native','current')`,[
    input.orgId,input.connectionId,resource.rows[0].id,input.nominalCapacityUnits??1
  ]);
  return resource.rows[0].id as string;
}

async function createCase(orgId:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[orgId]);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state,selected_actor_id)
    values($1,'maintenance','provider_pending',$2) returning id`,[domain.rows[0].id,actor.rows[0].id]);
  return created.rows[0].id as string;
}

async function createPartnerActor(orgId:string){
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[orgId]);
  return actor.rows[0].id as string;
}

describe('ROVIQ-native Shop OS capacity',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('allows overlapping appointments up to nominal resource capacity, then rejects the next one',async()=>{
    const {resourceId}=await setupNativeShop(2);
    const start=new Date(Date.now()+10*60_000).toISOString();
    const end=new Date(Date.now()+70*60_000).toISOString();

    const first=await createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    const second=await createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});

    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    await expect(createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'}))
      .rejects.toMatchObject({message:'shop_os_capacity_unavailable',statusCode:409});
  });

  it('restores bookable capacity after cancellation',async()=>{
    const {resourceId}=await setupNativeShop(1);
    const start=new Date(Date.now()+15*60_000).toISOString();
    const end=new Date(Date.now()+75*60_000).toISOString();

    const first=await createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    await expect(createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'}))
      .rejects.toMatchObject({message:'shop_os_capacity_unavailable',statusCode:409});

    await updateShopOsAppointment(admin,first.id,{action:'cancel',reason:'customer_cancelled'});
    const replacement=await createShopOsAppointment(admin,{resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    expect(replacement.id).toBeTruthy();
  });

  it('consumes a same-case canonical hold while another case hold still blocks capacity',async()=>{
    const {orgId,resourceId,windowId}=await setupNativeShop(1);
    const caseA=await createCase(orgId);
    const caseB=await createCase(orgId);
    const start=new Date(Date.now()+20*60_000).toISOString();
    const end=new Date(Date.now()+80*60_000).toISOString();

    await pool.query(`insert into capacity_reservations(service_case_id,capacity_window_id,units,state,expires_at)
      values($1,$3,1,'held',now()+interval '30 minutes'),($2,$3,1,'held',now()+interval '30 minutes')`,[caseA,caseB,windowId]);

    await expect(createShopOsAppointment(admin,{serviceCaseId:caseA,resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'}))
      .rejects.toMatchObject({message:'shop_os_capacity_unavailable',statusCode:409});

    await pool.query(`update capacity_reservations set state='released',released_at=now(),updated_at=now() where service_case_id=$1 and state='held'`,[caseB]);
    const booked=await createShopOsAppointment(admin,{serviceCaseId:caseA,resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    expect(booked.id).toBeTruthy();

    const reservation=await pool.query(`select state,consumed_at from capacity_reservations where service_case_id=$1 and capacity_window_id=$2`,[caseA,windowId]);
    expect(reservation.rows[0].state).toBe('consumed');
    expect(reservation.rows[0].consumed_at).toBeTruthy();
  });

  it('rolls back a failed cross-resource reschedule and succeeds after destination capacity is released',async()=>{
    const {orgId,connectionId,resourceId:resourceA}=await setupNativeShop(1);
    const resourceB=await createAdditionalResource({orgId,connectionId,name:'Bay 2',nominalCapacityUnits:1});
    const start=new Date(Date.now()+25*60_000).toISOString();
    const end=new Date(Date.now()+85*60_000).toISOString();

    const moving=await createShopOsAppointment(admin,{resourceId:resourceA,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    const blocker=await createShopOsAppointment(admin,{resourceId:resourceB,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});

    await expect(updateShopOsAppointment(admin,moving.id,{action:'reschedule',resourceId:resourceB}))
      .rejects.toMatchObject({message:'shop_os_capacity_unavailable',statusCode:409});

    const afterFailure=await pool.query(`select resource_id,appointment_status,lifecycle_version from roviq_appointments where id=$1`,[moving.id]);
    expect(afterFailure.rows[0].resource_id).toBe(resourceA);
    expect(afterFailure.rows[0].appointment_status).toBe('confirmed');
    expect(Number(afterFailure.rows[0].lifecycle_version)).toBe(1);

    await updateShopOsAppointment(admin,blocker.id,{action:'cancel',reason:'destination_released'});
    const moved=await updateShopOsAppointment(admin,moving.id,{action:'reschedule',resourceId:resourceB});
    expect(moved.resource_id).toBe(resourceB);
    expect(moved.appointment_status).toBe('confirmed');

    const replacement=await createShopOsAppointment(admin,{resourceId:resourceA,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    expect(replacement.id).toBeTruthy();
  });

  it('uses deterministic resource locking for concurrent opposite-direction swaps',async()=>{
    const {orgId,connectionId,resourceId:resourceA}=await setupNativeShop(2);
    const resourceB=await createAdditionalResource({orgId,connectionId,name:'Bay Swap',nominalCapacityUnits:2});
    const start=new Date(Date.now()+35*60_000).toISOString();
    const end=new Date(Date.now()+95*60_000).toISOString();
    const appointmentA=await createShopOsAppointment(admin,{resourceId:resourceA,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    const appointmentB=await createShopOsAppointment(admin,{resourceId:resourceB,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});

    const [movedA,movedB]=await Promise.all([
      updateShopOsAppointment(admin,appointmentA.id,{action:'reschedule',resourceId:resourceB}),
      updateShopOsAppointment(admin,appointmentB.id,{action:'reschedule',resourceId:resourceA})
    ]);
    expect(movedA.resource_id).toBe(resourceB);
    expect(movedB.resource_id).toBe(resourceA);
  });

  it('rejects attaching a case to a Shop OS resource from another organization',async()=>{
    const tenantA=await setupNativeShop(1);
    const tenantB=await setupNativeShop(1);
    const caseA=await createCase(tenantA.orgId);
    const start=new Date(Date.now()+40*60_000).toISOString();
    const end=new Date(Date.now()+100*60_000).toISOString();

    await expect(createShopOsAppointment(admin,{serviceCaseId:caseA,resourceId:tenantB.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'}))
      .rejects.toMatchObject({message:'service_case_tenant_mismatch',statusCode:409});
  });

  it('fails closed when a partner actor tries to manage another organization resource',async()=>{
    const tenantA=await setupNativeShop(1);
    const tenantB=await setupNativeShop(1);
    const partnerActorId=await createPartnerActor(tenantA.orgId);
    const partner={role:'partner',actorId:partnerActorId} as const;
    const start=new Date(Date.now()+30*60_000).toISOString();
    const end=new Date(Date.now()+90*60_000).toISOString();

    await expect(createShopOsAppointment(partner,{resourceId:tenantB.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'}))
      .rejects.toMatchObject({message:'forbidden',statusCode:403});

    const own=await createShopOsAppointment(partner,{resourceId:tenantA.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    expect(own.id).toBeTruthy();
  });
});
