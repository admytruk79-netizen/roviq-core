import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { appendCaseEvent, createDeadline, transitionCase } from './orchestration.js';
import { audit } from './audit.js';
import { queueNotification, setCustomerSnapshot } from './operations.js';

type PartItemInput = { sku:string; partNumber?:string; description?:string; quantity:number; attributes?:Record<string,unknown> };

function stringArray(value:unknown):string[]{
  return Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
}
function includesAll(have:string[],need:string[]){
  const set=new Set(have);
  return need.every((value)=>set.has(value));
}

async function resumeLinkedFieldService(principal:Principal,order:any){
  const attributes=order.attributes??{};
  const decisionId=typeof attributes.fieldServiceDecisionId==='string'?attributes.fieldServiceDecisionId:null;
  if(attributes.source!=='field_service_required_parts'||!decisionId)return false;
  try{
    const d=await pool.query('select * from field_service_decisions where id=$1 and case_id=$2',[decisionId,order.case_id]);
    if(!d.rowCount)return false;
    const decision=d.rows[0];
    if(decision.status!=='proposed'||decision.action!=='dispatch_field_technician')return false;
    const unsafe=decision.safety_flags&&typeof decision.safety_flags==='object'&&Object.values(decision.safety_flags).some(Boolean);
    if(unsafe||decision.drivability==='non_drivable'||Number(decision.confidence)<0.75||decision.repair_class==='unknown')return false;
    const operatorActorId=decision.operator_context?.operatorActorId as string|undefined;
    if(!operatorActorId)return false;
    const p=await pool.query('select * from field_service_actor_capabilities where actor_id=$1',[operatorActorId]);
    const profile=p.rows[0];
    if(!profile?.active||!profile?.verified_at)return false;
    if(!stringArray(profile.repair_classes).includes(decision.repair_class))return false;
    if(!includesAll(stringArray(profile.capabilities),stringArray(decision.required_capabilities)))return false;
    if(!includesAll(stringArray(profile.tools),stringArray(decision.required_tools)))return false;
    if(decision.estimated_minutes!=null&&profile.max_estimated_minutes!=null&&Number(decision.estimated_minutes)>Number(profile.max_estimated_minutes))return false;
    if(decision.estimated_cost!=null&&profile.max_estimated_cost!=null&&Number(decision.estimated_cost)>Number(profile.max_estimated_cost))return false;
    const nextStatus=decision.customer_authorization_required?'authorization_required':'proposed';
    const r=await pool.query(
      `update field_service_decisions
       set action='field_repair',status=$1,metadata=metadata||$2::jsonb,updated_at=now()
       where id=$3 and case_id=$4 and status='proposed' and action='dispatch_field_technician'
       returning *`,
      [nextStatus,JSON.stringify({fulfilledPartsOrderId:order.id,partsFulfilledAt:new Date().toISOString()}),decisionId,order.case_id]
    );
    if(!r.rowCount)return false;
    const sideEffects=await Promise.allSettled([
      appendCaseEvent(order.case_id,'FIELD_SERVICE_PARTS_READY',principal,{decisionId,orderId:order.id,action:'field_repair',status:nextStatus}),
      setCustomerSnapshot(
        order.case_id,
        nextStatus==='authorization_required'?'field_service_approval_required':'field_service_ready',
        'Required parts have arrived and the on-site repair is ready.',
        nextStatus==='authorization_required'?'Approval required':'Field operator may begin approved work'
      )
    ]);
    const failed=sideEffects.filter((result)=>result.status==='rejected');
    if(failed.length)console.warn('field_service_parts_ready_side_effect_failed',{decisionId,orderId:order.id,failedCount:failed.length});
    return true;
  }catch(error){
    console.warn('field_service_parts_resume_failed',{decisionId,orderId:order.id,error:error instanceof Error?error.message:'unknown_error'});
    return false;
  }
}

export async function createPartsOrder(principal: Principal, input:{ caseId:string; deliveryLocationId?:string; neededBy?:string; items:PartItemInput[]; attributes?:Record<string,unknown> }) {
  const c = await pool.query('select * from service_cases where id=$1',[input.caseId]);
  if (!c.rowCount) throw new Error('case_not_found');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const order = await client.query(
      `insert into parts_orders(case_id,requested_by_actor_id,delivery_location_id,needed_by,attributes)
       values($1,$2,$3,$4,$5) returning *`,
      [input.caseId,principal.actorId ?? null,input.deliveryLocationId ?? null,input.neededBy ?? null,JSON.stringify(input.attributes ?? {})]
    );
    for (const item of input.items) {
      await client.query(
        `insert into parts_order_items(order_id,sku,part_number,description,quantity,attributes)
         values($1,$2,$3,$4,$5,$6)`,
        [order.rows[0].id,item.sku,item.partNumber ?? null,item.description ?? null,item.quantity,JSON.stringify(item.attributes ?? {})]
      );
    }
    await client.query('commit');
    if (c.rows[0].state === 'repair_in_progress') await transitionCase(principal,input.caseId,'parts_pending',{ orderId:order.rows[0].id });
    await appendCaseEvent(input.caseId,'PARTS_ORDER_CREATED',principal,{ orderId:order.rows[0].id, itemCount:input.items.length });
    await setCustomerSnapshot(input.caseId,'parts_pending','Parts are being sourced for your vehicle.','Waiting for parts availability',input.neededBy);
    await audit(principal,'create_parts_order','parts_order',order.rows[0].id,'parts_requested',{ caseId:input.caseId });
    return getPartsOrder(order.rows[0].id);
  } catch (e) {
    await client.query('rollback').catch(()=>{});
    throw e;
  } finally { client.release(); }
}

export async function assignSupplier(principal: Principal, orderId:string, supplierActorId:string) {
  const supplier = await pool.query(`select id,actor_type,status from actors where id=$1`,[supplierActorId]);
  if (!supplier.rowCount || supplier.rows[0].status !== 'active') throw new Error('supplier_not_available');
  if (!['parts','partner','dealership'].includes(supplier.rows[0].actor_type)) throw new Error('invalid_supplier_type');
  const r = await pool.query(
    `update parts_orders set supplier_actor_id=$1,status='supplier_assigned',updated_at=now()
     where id=$2 and status in ('requested','supplier_assigned') returning *`,[supplierActorId,orderId]
  );
  if (!r.rowCount) throw new Error('order_not_assignable');
  await appendCaseEvent(r.rows[0].case_id,'PARTS_SUPPLIER_ASSIGNED',principal,{ orderId,supplierActorId });
  await queueNotification({ caseId:r.rows[0].case_id, channel:'push', recipientType:'actor', recipientId:supplierActorId, templateKey:'parts_order_assigned', payload:{ orderId } });
  await audit(principal,'assign_parts_supplier','parts_order',orderId,'supplier_assigned',{ supplierActorId });
  return getPartsOrder(orderId);
}

export async function reserveOrderInventory(principal: Principal, orderId:string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const orderResult = await client.query('select * from parts_orders where id=$1 for update',[orderId]);
    if (!orderResult.rowCount) throw new Error('order_not_found');
    const order = orderResult.rows[0];
    if (!order.supplier_actor_id) throw new Error('supplier_not_assigned');
    if (!['supplier_assigned','requested'].includes(order.status)) throw new Error('order_not_reservable');
    if (principal.role !== 'admin' && principal.actorId !== order.supplier_actor_id) throw new Error('forbidden');
    const items = await client.query('select * from parts_order_items where order_id=$1 order by created_at asc',[orderId]);
    for (const item of items.rows) {
      const inv = await client.query(
        `select * from parts_inventory where supplier_actor_id=$1 and sku=$2 and active=true
         and (quantity_on_hand-quantity_reserved) >= $3 order by updated_at asc limit 1 for update`,
        [order.supplier_actor_id,item.sku,item.quantity]
      );
      if (!inv.rowCount) throw new Error(`inventory_unavailable:${item.sku}`);
      await client.query('update parts_inventory set quantity_reserved=quantity_reserved+$1,updated_at=now() where id=$2',[item.quantity,inv.rows[0].id]);
      await client.query(
        `update parts_order_items set inventory_id=$1,unit_price=$2,currency=$3,status='reserved',updated_at=now() where id=$4`,
        [inv.rows[0].id,inv.rows[0].unit_price,inv.rows[0].currency,item.id]
      );
    }
    await client.query(`update parts_orders set status='reserved',updated_at=now() where id=$1`,[orderId]);
    await client.query('commit');
    await appendCaseEvent(order.case_id,'PARTS_RESERVED',principal,{ orderId });
    await audit(principal,'reserve_parts','parts_order',orderId,'inventory_reserved');
    return getPartsOrder(orderId);
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

export async function markPartsOrderStatus(principal: Principal, orderId:string, status:'ordered'|'shipped'|'delivered'|'cancelled'|'failed', metadata:Record<string,unknown>={}) {
  const current = await pool.query('select * from parts_orders where id=$1',[orderId]);
  if (!current.rowCount) throw new Error('order_not_found');
  const order = current.rows[0];
  if (principal.role !== 'admin' && principal.actorId !== order.supplier_actor_id) throw new Error('forbidden');
  const allowed:Record<string,string[]> = {
    reserved:['ordered','cancelled','failed'], ordered:['shipped','delivered','cancelled','failed'], shipped:['delivered','failed']
  };
  if (!allowed[order.status]?.includes(status)) throw new Error('invalid_parts_transition');
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (status === 'cancelled' || status === 'failed') {
      const items = await client.query(`select * from parts_order_items where order_id=$1 and status in ('reserved','ordered','shipped')`,[orderId]);
      for (const item of items.rows) {
        if (item.inventory_id) await client.query('update parts_inventory set quantity_reserved=greatest(quantity_reserved-$1,0),updated_at=now() where id=$2',[item.quantity,item.inventory_id]);
      }
      await client.query(`update parts_order_items set status=$1,updated_at=now() where order_id=$2 and status not in ('delivered','cancelled','failed')`,[status,orderId]);
    } else if (status === 'delivered') {
      const items = await client.query(`select * from parts_order_items where order_id=$1`,[orderId]);
      for (const item of items.rows) {
        if (item.inventory_id) {
          await client.query(
            `update parts_inventory set quantity_on_hand=greatest(quantity_on_hand-$1,0),quantity_reserved=greatest(quantity_reserved-$1,0),updated_at=now() where id=$2`,
            [item.quantity,item.inventory_id]
          );
        }
      }
      await client.query(`update parts_order_items set status='delivered',updated_at=now() where order_id=$1`,[orderId]);
    } else {
      await client.query(`update parts_order_items set status=$1,updated_at=now() where order_id=$2 and status not in ('delivered','cancelled','failed')`,[status,orderId]);
    }
    const r = await client.query(
      `update parts_orders set status=$1,tracking_reference=coalesce($2,tracking_reference),external_order_reference=coalesce($3,external_order_reference),
       updated_at=now(),delivered_at=case when $1='delivered' then now() else delivered_at end,cancelled_at=case when $1='cancelled' then now() else cancelled_at end
       where id=$4 returning *`,
      [status,metadata.trackingReference ?? null,metadata.externalOrderReference ?? null,orderId]
    );
    await client.query('commit');
    await appendCaseEvent(order.case_id,`PARTS_${status.toUpperCase()}`,principal,{ orderId,...metadata });
    if (status === 'delivered') {
      const linkedFieldService=order.attributes?.source==='field_service_required_parts'&&typeof order.attributes?.fieldServiceDecisionId==='string';
      if(linkedFieldService){
        const resumed=await resumeLinkedFieldService(principal,{...order,...r.rows[0],id:orderId});
        if(!resumed)await setCustomerSnapshot(order.case_id,'field_service_parts_ready_review','Required parts have arrived.','ROVIQ is reviewing field-service eligibility');
      }else{
        const c = await pool.query('select state from service_cases where id=$1',[order.case_id]);
        if (c.rowCount && c.rows[0].state === 'parts_pending') await transitionCase(principal,order.case_id,'repair_in_progress',{ orderId });
        await setCustomerSnapshot(order.case_id,'repair_resumed','Required parts have arrived and repair can continue.','Repair in progress');
      }
    } else if (status === 'failed') {
      await createDeadline(order.case_id,'parts_recovery',new Date(Date.now()+15*60*1000).toISOString(),'reassign_parts_supplier',{ orderId });
    }
    await audit(principal,'update_parts_order','parts_order',orderId,`parts_${status}`,metadata);
    return r.rows[0];
  } catch (e) {
    await client.query('rollback').catch(()=>{});
    throw e;
  } finally { client.release(); }
}

export async function upsertInventory(principal: Principal, input:{ supplierActorId?:string; sku:string; partNumber?:string; description?:string; quantityOnHand:number; unitPrice?:number; currency?:string; locationId?:string; attributes?:Record<string,unknown> }) {
  const supplierActorId = principal.role === 'admin' ? input.supplierActorId : principal.actorId;
  if (!supplierActorId) throw new Error('supplier_actor_required');
  const r = await pool.query(
    `insert into parts_inventory(supplier_actor_id,sku,part_number,description,quantity_on_hand,unit_price,currency,location_id,attributes)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict(supplier_actor_id,sku,location_id) do update set part_number=excluded.part_number,description=excluded.description,
     quantity_on_hand=excluded.quantity_on_hand,unit_price=excluded.unit_price,currency=excluded.currency,attributes=excluded.attributes,active=true,updated_at=now()
     returning *`,
    [supplierActorId,input.sku,input.partNumber ?? null,input.description ?? null,input.quantityOnHand,input.unitPrice ?? null,input.currency ?? 'USD',input.locationId ?? null,JSON.stringify(input.attributes ?? {})]
  );
  await audit(principal,'upsert_parts_inventory','parts_inventory',r.rows[0].id,'inventory_updated',{ supplierActorId, sku:input.sku });
  return r.rows[0];
}

export async function getPartsOrder(orderId:string) {
  const order = await pool.query('select * from parts_orders where id=$1',[orderId]);
  if (!order.rowCount) return null;
  const items = await pool.query('select * from parts_order_items where order_id=$1 order by created_at asc',[orderId]);
  return { order:order.rows[0], items:items.rows };
}
