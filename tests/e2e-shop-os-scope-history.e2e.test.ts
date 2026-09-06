import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { listConnectConnections, reportConnectionHealth, setConnectionControl } from '../src/services/connect-operations.js';
import { listShopResources } from '../src/services/shop-os-resources.js';
import { listShopWaitlist } from '../src/services/shop-os-waitlist.js';
import { listShopOsBoard } from '../src/services/shop-os-board.js';
import { createRepairOrder } from '../src/services/shop-os-repair-orders.js';

async function setupOrg(label:string){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[`Scoped ${label} ${Date.now()}-${Math.random()}`]);
  const actor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  const connection=await pool.query(`insert into partner_system_connections(
    organization_id,mode,provider_key,display_name,connection_status
  ) values($1,'roviq_native','roviq',$2,'active') returning id`,[org.rows[0].id,`Native ${label}`]);
  return {orgId:org.rows[0].id as string,actorId:actor.rows[0].id as string,connectionId:connection.rows[0].id as string};
}

describe('Shop OS scoped admin and historical costing',()=>{
  afterAll(async()=>{await pool.end();});

  it('limits an actor-backed admin to its organization across Connect and Shop OS surfaces',async()=>{
    const a=await setupOrg('A');
    const b=await setupOrg('B');
    const scopedAdmin={role:'admin',actorId:a.actorId} as const;

    const connections=await listConnectConnections(scopedAdmin);
    expect(connections.some((row:any)=>row.id===a.connectionId)).toBe(true);
    expect(connections.some((row:any)=>row.id===b.connectionId)).toBe(false);

    await expect(setConnectionControl(scopedAdmin,b.connectionId,{action:'pause'})).rejects.toThrow('forbidden');
    await expect(reportConnectionHealth(scopedAdmin,b.connectionId,{outcome:'success'})).rejects.toThrow('forbidden');
    await expect(listShopResources(scopedAdmin,{organizationId:b.orgId})).rejects.toMatchObject({message:'forbidden',statusCode:403});
    await expect(listShopWaitlist(scopedAdmin,{organizationId:b.orgId})).rejects.toMatchObject({message:'forbidden',statusCode:403});
    await expect(createRepairOrder(scopedAdmin,{organizationId:b.orgId})).rejects.toMatchObject({message:'forbidden',statusCode:403});

    const from=new Date(Date.now()-60_000).toISOString();
    const to=new Date(Date.now()+60_000).toISOString();
    await expect(listShopOsBoard(scopedAdmin,{organizationId:b.orgId,from,to})).rejects.toMatchObject({message:'forbidden',statusCode:403});

    expect((await setConnectionControl(scopedAdmin,a.connectionId,{action:'pause'})).connection_status).toBe('paused');
  });

  it('snapshots technician hourly cost so later resource-rate changes do not rewrite time history',async()=>{
    const shop=await setupOrg('Rate');
    const technician=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[shop.orgId]);
    const resource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id,operational_state,assigned_actor_id,hourly_cost
    ) values($1,'technician','Historical Tech',true,$2,'available',$3,100) returning id`,[shop.orgId,shop.connectionId,technician.rows[0].id]);
    const order=await pool.query(`insert into shop_repair_orders(organization_id,repair_order_number,status) values($1,$2,'in_progress') returning id`,[
      shop.orgId,`RO-HIST-${Date.now()}-${Math.random()}`
    ]);
    const work=await pool.query(`insert into shop_work_items(
      repair_order_id,organization_id,technician_actor_id,technician_resource_id,status,title
    ) values($1,$2,$3,$4,'in_progress','Historical labor') returning id`,[
      order.rows[0].id,shop.orgId,technician.rows[0].id,resource.rows[0].id
    ]);
    const time=await pool.query(`insert into shop_technician_time_entries(
      work_item_id,repair_order_id,organization_id,technician_actor_id,technician_resource_id,started_at,ended_at,end_reason
    ) values($1,$2,$3,$4,$5,now()-interval '1 hour',now(),'complete') returning hourly_cost_snapshot`,[
      work.rows[0].id,order.rows[0].id,shop.orgId,technician.rows[0].id,resource.rows[0].id
    ]);
    expect(Number(time.rows[0].hourly_cost_snapshot)).toBe(100);

    await pool.query(`update service_resources set hourly_cost=250 where id=$1`,[resource.rows[0].id]);
    const historical=await pool.query(`select hourly_cost_snapshot from shop_technician_time_entries where work_item_id=$1`,[work.rows[0].id]);
    expect(Number(historical.rows[0].hourly_cost_snapshot)).toBe(100);
  });
});