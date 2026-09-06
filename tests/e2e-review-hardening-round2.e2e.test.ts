import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { rebuildShopOsCapacity } from '../src/services/shop-os.js';
import { addRepairOrderLine, createRepairOrder, updateRepairOrder, updateRepairOrderLine } from '../src/services/shop-os-repair-orders.js';
import { reconcileRepairOrder } from '../src/services/shop-os-completion.js';
import { assignException, getExceptionQueue, updateExceptionState } from '../src/services/exception-engine.js';
import { assertAdminCaseScope } from '../src/services/admin-case-scope.js';

const globalAdmin={role:'admin'} as const;

async function setupShop(label:string){
  const org=await pool.query(`insert into organizations(organization_type,display_name) values('shop',$1) returning id`,[`${label}-${Date.now()}-${Math.random()}`]);
  const connection=await pool.query(`insert into partner_system_connections(organization_id,mode,provider_key,display_name,connection_status)
    values($1,'roviq_native','roviq',$2,'active') returning id`,[org.rows[0].id,`${label} Native`]);
  const shopActor=await pool.query(`insert into actors(actor_type,status,organization_id) values('shop','active',$1) returning id`,[org.rows[0].id]);
  const adminActor=await pool.query(`insert into actors(actor_type,status,organization_id) values('admin','active',$1) returning id`,[org.rows[0].id]);
  return {orgId:org.rows[0].id as string,connectionId:connection.rows[0].id as string,shopActorId:shopActor.rows[0].id as string,adminActorId:adminActor.rows[0].id as string};
}

async function createOwnedCase(shopActorId:string){
  const domain=await pool.query(`select id from domains where code='maintenance' limit 1`);
  const created=await pool.query(`insert into service_cases(domain_id,case_type,state) values($1,'maintenance','provider_selection') returning id`,[domain.rows[0].id]);
  await pool.query(`update service_cases set current_owner_role='partner',current_owner_actor_id=$2 where id=$1`,[created.rows[0].id,shopActorId]);
  return created.rows[0].id as string;
}

describe('review hardening round two',()=>{
  afterAll(async()=>{await pool.end();});

  it('preserves blocked and degraded capacity authority while rebuilding occupancy',async()=>{
    const shop=await setupShop('Capacity guard');
    const resource=await pool.query(`insert into service_resources(organization_id,resource_type,display_name,active,source_connection_id,operational_state)
      values($1,'bay','Bay',true,$2,'available') returning id`,[shop.orgId,shop.connectionId]);
    const window=await pool.query(`insert into capacity_windows(
      organization_id,source_connection_id,resource_id,window_start,window_end,capacity_state,capacity_units,nominal_capacity_units,confidence,sync_state
    ) values($1,$2,$3,now()-interval '1 hour',now()+interval '8 hours','blocked',0,2,'roviq_native','current') returning id`,[shop.orgId,shop.connectionId,resource.rows[0].id]);

    await rebuildShopOsCapacity(resource.rows[0].id,pool);
    let current=await pool.query(`select capacity_state,sync_state from capacity_windows where id=$1`,[window.rows[0].id]);
    expect(current.rows[0]).toMatchObject({capacity_state:'blocked',sync_state:'current'});

    await pool.query(`update capacity_windows set capacity_state='available',sync_state='degraded' where id=$1`,[window.rows[0].id]);
    await rebuildShopOsCapacity(resource.rows[0].id,pool);
    current=await pool.query(`select capacity_state,sync_state from capacity_windows where id=$1`,[window.rows[0].id]);
    expect(current.rows[0]).toMatchObject({capacity_state:'available',sync_state:'degraded'});
  });

  it('uses tracked labor once and keeps reconciliation accounting dates stable on retry',async()=>{
    const shop=await setupShop('Accounting guard');
    const tech=await pool.query(`insert into actors(actor_type,status,organization_id) values('technician','active',$1) returning id`,[shop.orgId]);
    const techResource=await pool.query(`insert into service_resources(
      organization_id,resource_type,display_name,active,source_connection_id,operational_state,assigned_actor_id,hourly_cost
    ) values($1,'technician','Tech',true,$2,'available',$3,80) returning id`,[shop.orgId,shop.connectionId,tech.rows[0].id]);
    const caseId=await createOwnedCase(shop.shopActorId);
    const order=await createRepairOrder(globalAdmin,{organizationId:shop.orgId,serviceCaseId:caseId,primaryTechnicianActorId:tech.rows[0].id});
    const labor=await addRepairOrderLine(globalAdmin,order.id,{lineType:'labor',description:'Labor',quantity:1,unitPrice:200,unitCost:100,laborHours:1});
    await updateRepairOrder(globalAdmin,order.id,{action:'submit_estimate'});
    await updateRepairOrderLine(globalAdmin,order.id,labor.line.id,{approvalStatus:'approved'});
    await updateRepairOrder(globalAdmin,order.id,{action:'approve'});
    await updateRepairOrder(globalAdmin,order.id,{action:'start'});
    const work=await pool.query(`insert into shop_work_items(
      repair_order_id,repair_order_line_id,organization_id,technician_actor_id,technician_resource_id,status,title,started_at,completed_at
    ) values($1,$2,$3,$4,$5,'completed','Labor',now()-interval '1 hour',now()) returning id`,[
      order.id,labor.line.id,shop.orgId,tech.rows[0].id,techResource.rows[0].id
    ]);
    await pool.query(`insert into shop_technician_time_entries(
      work_item_id,repair_order_id,organization_id,technician_actor_id,technician_resource_id,started_at,ended_at,end_reason,hourly_cost_snapshot
    ) values($1,$2,$3,$4,$5,now()-interval '1 hour',now(),'complete',80)`,[
      work.rows[0].id,order.id,shop.orgId,tech.rows[0].id,techResource.rows[0].id
    ]);
    await updateRepairOrder(globalAdmin,order.id,{action:'qc'});
    await updateRepairOrder(globalAdmin,order.id,{action:'complete'});

    const first=await reconcileRepairOrder(globalAdmin,order.id);
    expect(first.directCost).toBe(0);
    expect(first.laborCost).toBeGreaterThan(79);
    expect(first.laborCost).toBeLessThan(81);
    expect(first.contribution).toBeGreaterThan(119);
    expect(first.contribution).toBeLessThan(121);
    const firstDates=await pool.query(`select reconciliation_key,occurred_at from ledger_entries where repair_order_id=$1 order by reconciliation_key`,[order.id]);
    const second=await reconcileRepairOrder(globalAdmin,order.id);
    expect(second.laborCostSource).toBe('technician_time_snapshot');
    const secondDates=await pool.query(`select reconciliation_key,occurred_at from ledger_entries where repair_order_id=$1 order by reconciliation_key`,[order.id]);
    expect(secondDates.rows.map((row)=>row.occurred_at.toISOString())).toEqual(firstDates.rows.map((row)=>row.occurred_at.toISOString()));
  });

  it('scopes exception queues, case mutations and exception owners for actor-backed admins',async()=>{
    const shopA=await setupShop('Scoped A');
    const shopB=await setupShop('Scoped B');
    const caseA=await createOwnedCase(shopA.shopActorId);
    const caseB=await createOwnedCase(shopB.shopActorId);
    const exceptionA=await pool.query(`insert into case_exceptions(case_id,exception_code,summary,severity,state) values($1,'A','A','warning','open') returning id`,[caseA]);
    const exceptionB=await pool.query(`insert into case_exceptions(case_id,exception_code,summary,severity,state) values($1,'B','B','critical','open') returning id`,[caseB]);
    const scopedAdmin={role:'admin',actorId:shopA.adminActorId} as const;

    const queue=await getExceptionQueue(scopedAdmin,{});
    expect(queue.map((row)=>row.id)).toContain(exceptionA.rows[0].id);
    expect(queue.map((row)=>row.id)).not.toContain(exceptionB.rows[0].id);
    await expect(assertAdminCaseScope(scopedAdmin,caseB,pool)).rejects.toMatchObject({message:'forbidden',statusCode:403});
    await expect(updateExceptionState(scopedAdmin,exceptionB.rows[0].id,{state:'acknowledged'})).rejects.toMatchObject({message:'forbidden',statusCode:403});
    await expect(assignException(scopedAdmin,exceptionA.rows[0].id,{ownerActorId:shopB.shopActorId})).rejects.toMatchObject({message:'exception_owner_scope_mismatch',statusCode:409});
  });
});
