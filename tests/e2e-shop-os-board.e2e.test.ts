import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createShopOsAppointment } from '../src/services/shop-os.js';
import { listShopOsBoard } from '../src/services/shop-os-board.js';

async function setupShop(){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[
    `Shop OS Board ${Date.now()}-${Math.random()}`
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
      'available',2,2,'roviq_native','current')`,[org.rows[0].id,connection.rows[0].id,resource.rows[0].id]);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  return {orgId:org.rows[0].id as string,resourceId:resource.rows[0].id as string,actorId:actor.rows[0].id as string};
}

describe('Shop OS operational board',()=>{
  afterAll(async()=>{ await pool.end(); });

  it('returns canonical native resources, appointments, capacity and summary for a partner scope',async()=>{
    const shop=await setupShop();
    const partner={role:'partner',actorId:shop.actorId} as const;
    const start=new Date(Date.now()+30*60_000).toISOString();
    const end=new Date(Date.now()+90*60_000).toISOString();
    await createShopOsAppointment(partner,{resourceId:shop.resourceId,startsAt:start,endsAt:end,serviceCategory:'repair',status:'confirmed'});

    const board=await listShopOsBoard(partner,{
      from:new Date(Date.now()-60*60_000).toISOString(),
      to:new Date(Date.now()+4*60*60_000).toISOString()
    });

    expect(board.scope.organizationId).toBe(shop.orgId);
    expect(board.resources).toHaveLength(1);
    expect(board.appointments).toHaveLength(1);
    expect(board.capacity).toHaveLength(1);
    expect(board.summary.resourceCount).toBe(1);
    expect(board.summary.appointmentCount).toBe(1);
    expect(board.summary.activeAppointments).toBe(1);
    expect(board.summary.appointmentStatusCounts.confirmed).toBe(1);
    expect(board.summary.nominalCapacityUnits).toBe(2);
    expect(board.summary.availableCapacityUnits).toBe(1);
  });

  it('rejects cross-tenant board access for partner actors',async()=>{
    const shopA=await setupShop();
    const shopB=await setupShop();
    const partner={role:'partner',actorId:shopA.actorId} as const;

    await expect(listShopOsBoard(partner,{
      organizationId:shopB.orgId,
      from:new Date(Date.now()-60*60_000).toISOString(),
      to:new Date(Date.now()+4*60*60_000).toISOString()
    })).rejects.toMatchObject({message:'forbidden',statusCode:403});
  });

  it('requires an explicit organization scope for admin board access',async()=>{
    const admin={role:'admin'} as const;
    await expect(listShopOsBoard(admin,{
      from:new Date(Date.now()-60*60_000).toISOString(),
      to:new Date(Date.now()+4*60*60_000).toISOString()
    })).rejects.toMatchObject({message:'organization_id_required',statusCode:400});
  });
});
