import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopOsAppointment } from '../src/services/shop-os.js';
import { createShopWaitlistEntry, listShopWaitlist, updateShopWaitlistEntry } from '../src/services/shop-os-waitlist.js';

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Waitlist ${Date.now()}-${Math.random()}`
  ]);
  const connection=await pool.query(`insert into partner_system_connections(
      organization_id,mode,provider_key,display_name,connection_status
    ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,[org.rows[0].id]);
  const resource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id
    ) values($1,'bay','Bay A',true,$2) returning id`,[org.rows[0].id,connection.rows[0].id]);
  await pool.query(`insert into capacity_windows(
      organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
      capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
    ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '8 hours',
      'available',1,1,'roviq_native','current')`,[org.rows[0].id,connection.rows[0].id,resource.rows[0].id]);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  return {orgId:org.rows[0].id as string,resourceId:resource.rows[0].id as string,actorId:actor.rows[0].id as string};
}

async function createCaseForActor(actorId:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state,selected_actor_id)
    values($1,'maintenance','provider_pending',$2) returning id`,[domain.rows[0].id,actorId]);
  return created.rows[0].id as string;
}

describe('Shop OS waitlist',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('creates, offers and books a case-less waitlist entry only into a case-less native appointment',async()=>{
    const shop=await setupShop();
    const partner={role:'partner',actorId:shop.actorId} as const;
    const entry=await createShopWaitlistEntry(partner,{requestedServiceCategory:'repair',priority:10,estimatedDurationMinutes:60});
    expect(entry.state).toBe('waiting');

    const offered=await updateShopWaitlistEntry(partner,entry.id,{
      action:'offer',offerExpiresAt:new Date(Date.now()+30*60_000).toISOString()
    });
    expect(offered.state).toBe('offered');
    expect(offered.offer_expires_at).toBeTruthy();

    const start=new Date(Date.now()+60*60_000).toISOString();
    const end=new Date(Date.now()+120*60_000).toISOString();
    const appointment=await createShopOsAppointment(partner,{resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    const booked=await updateShopWaitlistEntry(partner,entry.id,{action:'book',appointmentId:appointment.id});
    expect(booked.state).toBe('booked');
    expect(booked.booked_appointment_id).toBe(appointment.id);

    const active=await listShopWaitlist(partner,{});
    expect(active.entries.find((item)=>item.id===entry.id)).toBeUndefined();
    const bookedEntries=await listShopWaitlist(partner,{states:['booked']});
    expect(bookedEntries.entries.find((item)=>item.id===entry.id)).toBeTruthy();
  });

  it('rejects past and exactly-current offer deadlines and rejects booking an expired offered entry',async()=>{
    const shop=await setupShop();
    const partner={role:'partner',actorId:shop.actorId} as const;
    const past=await createShopWaitlistEntry(partner,{requestedServiceCategory:'repair'});
    await expect(updateShopWaitlistEntry(partner,past.id,{action:'offer',offerExpiresAt:new Date(Date.now()-1000).toISOString()}))
      .rejects.toMatchObject({message:'offer_expiry_invalid',statusCode:400});

    const exact=await createShopWaitlistEntry(partner,{requestedServiceCategory:'repair'});
    await expect(updateShopWaitlistEntry(partner,exact.id,{action:'offer',offerExpiresAt:new Date().toISOString()}))
      .rejects.toMatchObject({message:'offer_expiry_invalid',statusCode:400});

    const expiring=await createShopWaitlistEntry(partner,{requestedServiceCategory:'repair'});
    await updateShopWaitlistEntry(partner,expiring.id,{action:'offer',offerExpiresAt:new Date(Date.now()+30*60_000).toISOString()});
    await pool.query(`update shop_waitlist_entries set offer_expires_at=now()-interval '1 second' where id=$1`,[expiring.id]);
    const start=new Date(Date.now()+60*60_000).toISOString();
    const end=new Date(Date.now()+120*60_000).toISOString();
    const appointment=await createShopOsAppointment(partner,{resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});
    await expect(updateShopWaitlistEntry(partner,expiring.id,{action:'book',appointmentId:appointment.id}))
      .rejects.toMatchObject({message:'waitlist_offer_expired',statusCode:409});
  });

  it('supports offer expiry and requeue without losing the waitlist record',async()=>{
    const shop=await setupShop();
    const partner={role:'partner',actorId:shop.actorId} as const;
    const entry=await createShopWaitlistEntry(partner,{requestedServiceCategory:'repair'});
    await updateShopWaitlistEntry(partner,entry.id,{action:'offer',offerExpiresAt:new Date(Date.now()+5*60_000).toISOString()});
    const expired=await updateShopWaitlistEntry(partner,entry.id,{action:'expire'});
    expect(expired.state).toBe('expired');
    const requeued=await updateShopWaitlistEntry(partner,entry.id,{action:'requeue'});
    expect(requeued.state).toBe('waiting');
    expect(requeued.offer_expires_at).toBeNull();
  });

  it('rejects booking a waitlist entry into an appointment for a different case',async()=>{
    const shop=await setupShop();
    const partner={role:'partner',actorId:shop.actorId} as const;
    const caseA=await createCaseForActor(shop.actorId);
    const caseB=await createCaseForActor(shop.actorId);
    const entry=await createShopWaitlistEntry(partner,{serviceCaseId:caseA,requestedServiceCategory:'repair'});
    const start=new Date(Date.now()+90*60_000).toISOString();
    const end=new Date(Date.now()+150*60_000).toISOString();
    const appointment=await createShopOsAppointment(partner,{serviceCaseId:caseB,resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});

    await expect(updateShopWaitlistEntry(partner,entry.id,{action:'book',appointmentId:appointment.id}))
      .rejects.toMatchObject({message:'waitlist_case_mismatch',statusCode:409});
  });

  it('prevents tenant-crossing case links even for an admin-scoped waitlist write',async()=>{
    const shopA=await setupShop();
    const shopB=await setupShop();
    const caseA=await createCaseForActor(shopA.actorId);
    const admin={role:'admin'} as const;

    await expect(createShopWaitlistEntry(admin,{organizationId:shopB.orgId,serviceCaseId:caseA,requestedServiceCategory:'repair'}))
      .rejects.toMatchObject({message:'service_case_tenant_mismatch',statusCode:409});
  });

  it('prevents one partner tenant from reading or mutating another tenant waitlist',async()=>{
    const shopA=await setupShop();
    const shopB=await setupShop();
    const partnerA={role:'partner',actorId:shopA.actorId} as const;
    const partnerB={role:'partner',actorId:shopB.actorId} as const;
    const foreign=await createShopWaitlistEntry(partnerB,{requestedServiceCategory:'repair'});

    await expect(listShopWaitlist(partnerA,{organizationId:shopB.orgId})).rejects.toMatchObject({message:'forbidden',statusCode:403});
    await expect(updateShopWaitlistEntry(partnerA,foreign.id,{action:'cancel'})).rejects.toMatchObject({message:'forbidden',statusCode:403});
  });
});
