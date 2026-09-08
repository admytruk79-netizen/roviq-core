import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopOsAppointment, updateShopOsAppointment } from '../src/services/shop-os.js';
import { createShopWaitlistEntry, updateShopWaitlistEntry } from '../src/services/shop-os-waitlist.js';

const admin={role:'admin'} as const;

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Devin Regression ${Date.now()}-${Math.random()}`
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
  return {orgId:org.rows[0].id as string,resourceId:resource.rows[0].id as string};
}

describe('Shop OS Devin regressions',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('rejects lifecycle actions that try to mutate schedule fields',async()=>{
    const shop=await setupShop();
    const start=new Date(Date.now()+30*60_000).toISOString();
    const end=new Date(Date.now()+90*60_000).toISOString();
    const movedStart=new Date(Date.now()+45*60_000).toISOString();
    const appointment=await createShopOsAppointment(admin,{
      resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'
    });

    await expect(updateShopOsAppointment(admin,appointment.id,{action:'start',startsAt:movedStart}))
      .rejects.toMatchObject({message:'schedule_change_requires_reschedule',statusCode:400});

    const stored=await pool.query(`select appointment_status,starts_at,ends_at,resource_id from roviq_appointments where id=$1`,[appointment.id]);
    expect(stored.rows[0].appointment_status).toBe('confirmed');
    expect(new Date(stored.rows[0].starts_at).toISOString()).toBe(start);
    expect(new Date(stored.rows[0].ends_at).toISOString()).toBe(end);
    expect(stored.rows[0].resource_id).toBe(shop.resourceId);
  });

  it('does not close a waitlist entry with an inactive appointment',async()=>{
    const shop=await setupShop();
    const start=new Date(Date.now()+35*60_000).toISOString();
    const end=new Date(Date.now()+95*60_000).toISOString();
    const appointment=await createShopOsAppointment(admin,{
      resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'
    });
    await updateShopOsAppointment(admin,appointment.id,{action:'cancel',reason:'test_cancel'});

    const entry=await createShopWaitlistEntry(admin,{organizationId:shop.orgId,requestedServiceCategory:'repair'});
    await expect(updateShopWaitlistEntry(admin,entry.id,{action:'book',appointmentId:appointment.id}))
      .rejects.toMatchObject({message:'waitlist_appointment_inactive',statusCode:409});

    const stored=await pool.query(`select state,booked_appointment_id from shop_waitlist_entries where id=$1`,[entry.id]);
    expect(stored.rows[0].state).toBe('waiting');
    expect(stored.rows[0].booked_appointment_id).toBeNull();
  });
});
