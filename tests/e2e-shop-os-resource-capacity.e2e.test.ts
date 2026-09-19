import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { updateShopResource } from '../src/services/shop-os-resources.js';
import { createShopOsAppointment } from '../src/services/shop-os-appointment-create.js';

const admin={role:'admin'} as const;

async function setupNativeResource(capacityState:'available'|'blocked'='available'){
  const org=await pool.query(
    `insert into organizations(organization_type,display_name) values('shop',$1) returning id`,
    [`Shop OS Resource Capacity ${Date.now()}-${Math.random()}`]
  );
  const connection=await pool.query(
    `insert into partner_system_connections(
       organization_id,mode,provider_key,display_name,connection_status
     ) values($1,'roviq_native','roviq','Shop OS Native','active') returning id`,
    [org.rows[0].id]
  );
  const resource=await pool.query(
    `insert into service_resources(
       organization_id,resource_type,display_name,active,source_connection_id,operational_state
     ) values($1,'bay','Production Bay',true,$2,'available') returning id`,
    [org.rows[0].id,connection.rows[0].id]
  );
  const window=await pool.query(
    `insert into capacity_windows(
       organization_id,source_connection_id,resource_id,service_category,window_start,window_end,
       capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state,constraint_summary
     ) values($1,$2,$3,'repair',now()-interval '1 hour',now()+interval '4 hours',
       $4,case when $4='blocked' then 0 else 2 end,2,'roviq_native','current','{}'::jsonb)
     returning id`,
    [org.rows[0].id,connection.rows[0].id,resource.rows[0].id,capacityState]
  );
  return {
    orgId:org.rows[0].id as string,
    resourceId:resource.rows[0].id as string,
    windowId:window.rows[0].id as string
  };
}

describe('Shop OS resource operational state owns canonical capacity',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('fails capacity closed while a native resource is offline and restores it when available',async()=>{
    const {resourceId,windowId}=await setupNativeResource();

    await updateShopResource(admin,resourceId,{operationalState:'offline'});
    const offline=await pool.query(
      `select capacity_state,capacity_units,constraint_summary from capacity_windows where id=$1`,
      [windowId]
    );
    expect(offline.rows[0].capacity_state).toBe('blocked');
    expect(Number(offline.rows[0].capacity_units)).toBe(0);
    expect(offline.rows[0].constraint_summary.resourceStateBlock.operationalState).toBe('offline');

    const startsAt=new Date(Date.now()+30*60_000).toISOString();
    const endsAt=new Date(Date.now()+75*60_000).toISOString();
    await expect(createShopOsAppointment(admin,{
      resourceId,startsAt,endsAt,serviceCategory:'repair',status:'held'
    })).rejects.toMatchObject({message:'shop_os_resource_not_found',statusCode:404});

    await updateShopResource(admin,resourceId,{operationalState:'available'});
    const restored=await pool.query(
      `select capacity_state,capacity_units,constraint_summary from capacity_windows where id=$1`,
      [windowId]
    );
    expect(restored.rows[0].capacity_state).toBe('available');
    expect(Number(restored.rows[0].capacity_units)).toBe(2);
    expect(restored.rows[0].constraint_summary.resourceStateBlock).toBeUndefined();

    const appointment=await createShopOsAppointment(admin,{
      resourceId,startsAt,endsAt,serviceCategory:'repair',status:'held'
    });
    expect(appointment.appointment_status).toBe('held');
  });

  it('does not erase a pre-existing blocked capacity window when a resource returns online',async()=>{
    const {resourceId,windowId}=await setupNativeResource('blocked');

    await updateShopResource(admin,resourceId,{operationalState:'offline'});
    await updateShopResource(admin,resourceId,{operationalState:'available'});

    const restored=await pool.query(
      `select capacity_state,capacity_units,constraint_summary from capacity_windows where id=$1`,
      [windowId]
    );
    expect(restored.rows[0].capacity_state).toBe('blocked');
    expect(Number(restored.rows[0].capacity_units)).toBe(0);
    expect(restored.rows[0].constraint_summary.resourceStateBlock).toBeUndefined();
  });
});
