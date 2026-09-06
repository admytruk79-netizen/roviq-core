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

describe('Shop OS waitlist',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('creates, offers and books a waitlist entry into a native appointment',async()=>{
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
