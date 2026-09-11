import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { syncPartsOperationalConstraint } from './case-constraint-projection.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

type Queryable=Pick<PoolClient,'query'>;
type PartReadiness='identified'|'sourcing'|'ordered'|'eta_known'|'received'|'ready'|'unavailable'|'cancelled';
type DeferredAction='remind'|'book'|'complete'|'dismiss'|'reopen';

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

async function resolveScope(principal:Principal,input:{organizationId?:string;locationId?:string},db:Queryable){
  return resolveShopPrincipalScope(principal,input,db);
}

async function lockServiceCase(caseId:string,db:Queryable){
  const result=await db.query('select id from service_cases where id=$1 for update',[caseId]);
  if(!result.rowCount) throw httpError('case_not_found',404);
}

async function loadOrder(principal:Principal,repairOrderId:string,db:Queryable,forUpdate=false){
  const result=await db.query(`select * from shop_repair_orders where id=$1${forUpdate?' for update':''}`,[repairOrderId]);
  if(!result.rowCount) throw httpError('repair_order_not_found',404);
  const row=result.rows[0];
  await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},db);
  return row;
}

async function appendEvent(db:Queryable,repairOrderId:string,eventType:string,principal:Principal,payload:Record<string,unknown>={}){
  await db.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload)
    values('repair_order',$1,$2,$3,$4,$5)`,[
    repairOrderId,eventType,principal.actorId??null,principal.role,JSON.stringify(payload)
  ]);
}

export async function createRepairOrderPartRequirement(principal:Principal,input:{
  repairOrderId:string;repairOrderLineId:string;description?:string|null;partReference?:string|null;quantity?:number;
  supplierReference?:string|null;partsOrderId?:string|null;eta?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const discovered=await client.query('select service_case_id from shop_repair_orders where id=$1',[input.repairOrderId]);
    if(!discovered.rowCount) throw httpError('repair_order_not_found',404);
    const caseId=discovered.rows[0].service_case_id as string|null;
    if(!caseId) throw httpError('repair_order_case_required',409);
    await lockServiceCase(caseId,client);
    const order=await loadOrder(principal,input.repairOrderId,client,true);
    if(order.service_case_id!==caseId) throw httpError('repair_order_case_changed',409);
    if(['closed','cancelled'].includes(order.status)) throw httpError('repair_order_inactive',409);
    const line=await client.query(`select * from shop_repair_order_lines where id=$1 and repair_order_id=$2 for update`,[input.repairOrderLineId,input.repairOrderId]);
    if(!line.rowCount) throw httpError('repair_order_line_not_found',404);
    if(line.rows[0].line_type!=='part') throw httpError('part_requirement_line_type_invalid',409);
    if(line.rows[0].approval_status!=='approved') throw httpError('part_requirement_line_not_approved',409);
    if(input.partsOrderId){
      const po=await client.query(`select id,case_id from parts_orders where id=$1`,[input.partsOrderId]);
      if(!po.rowCount) throw httpError('parts_order_not_found',404);
      if(po.rows[0].case_id!==caseId) throw httpError('parts_order_case_mismatch',409);
    }
    const created=await client.query(`insert into case_parts_requirements(
      service_case_id,repair_order_id,repair_order_line_id,parts_order_id,part_reference,description,quantity,
      readiness_status,eta,supplier_reference
    ) values($1,$2,$3,$4,$5,$6,$7,'identified',$8,$9) returning *`,[
      caseId,input.repairOrderId,input.repairOrderLineId,input.partsOrderId??null,input.partReference??null,
      input.description??line.rows[0].description,input.quantity??Number(line.rows[0].quantity),input.eta??null,input.supplierReference??null
    ]);
    await syncPartsOperationalConstraint(caseId,client);
    await appendEvent(client,input.repairOrderId,'SHOP_OS_PART_REQUIREMENT_CREATED',principal,{requirementId:created.rows[0].id,lineId:input.repairOrderLineId});
    await client.query('commit');
    return created.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function updateRepairOrderPartRequirement(principal:Principal,requirementId:string,input:{
  readinessStatus:PartReadiness;eta?:string|null;supplierReference?:string|null;partsOrderId?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const discovered=await client.query('select service_case_id from case_parts_requirements where id=$1',[requirementId]);
    if(!discovered.rowCount) throw httpError('part_requirement_not_found',404);
    const caseId=discovered.rows[0].service_case_id as string;
    await lockServiceCase(caseId,client);
    const current=await client.query(`select cpr.*,ro.organization_id,ro.location_id
      from case_parts_requirements cpr join shop_repair_orders ro on ro.id=cpr.repair_order_id
      where cpr.id=$1 for update`,[requirementId]);
    if(!current.rowCount) throw httpError('part_requirement_not_found',404);
    const row=current.rows[0];
    if(row.service_case_id!==caseId) throw httpError('part_requirement_case_changed',409);
    await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},client);
    if(input.partsOrderId){
      const po=await client.query(`select id,case_id from parts_orders where id=$1`,[input.partsOrderId]);
      if(!po.rowCount) throw httpError('parts_order_not_found',404);
      if(po.rows[0].case_id!==caseId) throw httpError('parts_order_case_mismatch',409);
    }
    const updated=await client.query(`update case_parts_requirements set
      readiness_status=$2,eta=case when $3::boolean then $4::timestamptz else eta end,
      supplier_reference=case when $5::boolean then $6::text else supplier_reference end,
      parts_order_id=case when $7::boolean then $8::uuid else parts_order_id end,updated_at=now()
      where id=$1 returning *`,[
      requirementId,input.readinessStatus,Object.prototype.hasOwnProperty.call(input,'eta'),input.eta??null,
      Object.prototype.hasOwnProperty.call(input,'supplierReference'),input.supplierReference??null,
      Object.prototype.hasOwnProperty.call(input,'partsOrderId'),input.partsOrderId??null
    ]);
    await syncPartsOperationalConstraint(caseId,client);
    await appendEvent(client,row.repair_order_id,'SHOP_OS_PART_READINESS_UPDATED',principal,{requirementId,readinessStatus:input.readinessStatus});
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function listRepairOrderPartRequirements(principal:Principal,repairOrderId:string){
  const client=await pool.connect();
  try{
    await loadOrder(principal,repairOrderId,client,false);
    const result=await client.query(`select * from case_parts_requirements where repair_order_id=$1 order by updated_at desc,id`,[repairOrderId]);
    return {requirements:result.rows};
  }finally{client.release();}
}

export async function deferRepairOrderLine(principal:Principal,input:{
  repairOrderId:string;repairOrderLineId:string;severity?:'recommended'|'attention'|'urgent';reason?:string|null;
  targetReturnAt?:string|null;nextFollowUpAt?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const order=await loadOrder(principal,input.repairOrderId,client,true);
    const line=await client.query(`select * from shop_repair_order_lines where id=$1 and repair_order_id=$2 for update`,[input.repairOrderLineId,input.repairOrderId]);
    if(!line.rowCount) throw httpError('repair_order_line_not_found',404);
    if(!['deferred','declined'].includes(line.rows[0].approval_status)) throw httpError('deferred_line_status_required',409);
    const created=await client.query(`insert into shop_deferred_service_items(
      organization_id,location_id,service_case_id,repair_order_id,repair_order_line_id,customer_vehicle_id,
      severity,reason,estimated_amount,target_return_at,next_follow_up_at,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict(repair_order_line_id) do update set
      severity=excluded.severity,reason=excluded.reason,target_return_at=excluded.target_return_at,
      next_follow_up_at=excluded.next_follow_up_at,
      status='open',dismissed_at=null,completed_at=null,booked_appointment_id=null,updated_at=now()
    returning *`,[
      order.organization_id,order.location_id,order.service_case_id,input.repairOrderId,input.repairOrderLineId,order.customer_vehicle_id,
      input.severity??'recommended',input.reason??null,Number(line.rows[0].quantity)*Number(line.rows[0].unit_price),
      input.targetReturnAt??null,input.nextFollowUpAt??input.targetReturnAt??null,principal.actorId??null
    ]);
    await appendEvent(client,input.repairOrderId,'SHOP_OS_DEFERRED_SERVICE_CREATED',principal,{deferredItemId:created.rows[0].id,lineId:input.repairOrderLineId,severity:created.rows[0].severity});
    await client.query('commit');
    return created.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function listDeferredService(principal:Principal,input:{organizationId?:string;locationId?:string;statuses?:string[]}){
  const client=await pool.connect();
  try{
    const scope=await resolveScope(principal,input,client);
    const result=await client.query(`select d.*,l.description as line_description,l.service_category
      from shop_deferred_service_items d join shop_repair_order_lines l on l.id=d.repair_order_line_id
      where d.organization_id=$1 and ($2::uuid is null or d.location_id=$2::uuid)
        and ($3::text[] is null or d.status=any($3::text[]))
      order by coalesce(d.next_follow_up_at,d.target_return_at,'infinity'::timestamptz),d.updated_at desc`,[
      scope.organizationId,scope.locationId,input.statuses?.length?input.statuses:null
    ]);
    return {scope,deferredItems:result.rows};
  }finally{client.release();}
}

export async function updateDeferredService(principal:Principal,deferredItemId:string,input:{
  action:DeferredAction;appointmentId?:string|null;nextFollowUpAt?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const discovered=await client.query(`select service_case_id from shop_deferred_service_items where id=$1`,[deferredItemId]);
    if(!discovered.rowCount) throw httpError('deferred_service_not_found',404);
    const discoveredCaseId=discovered.rows[0].service_case_id as string|null;
    if(input.action==='book'&&!discoveredCaseId) throw httpError('deferred_service_case_required_for_booking',409);
    if(discoveredCaseId) await lockServiceCase(discoveredCaseId,client);
    const current=await client.query(`select d.*,l.service_category as deferred_service_category
      from shop_deferred_service_items d
      join shop_repair_order_lines l on l.id=d.repair_order_line_id
      where d.id=$1
      for update of d,l`,[deferredItemId]);
    if(!current.rowCount) throw httpError('deferred_service_not_found',404);
    const row=current.rows[0];
    if((row.service_case_id??null)!==discoveredCaseId) throw httpError('deferred_service_case_changed',409);
    await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},client);
    let nextStatus=row.status as string;
    if(input.action==='remind'){
      if(!['open','reminded'].includes(row.status)) throw httpError('deferred_service_transition_invalid',409);
      nextStatus='reminded';
      if(row.service_case_id){
        const customer=await client.query(`select customer_actor_id from service_cases where id=$1`,[row.service_case_id]);
        if(customer.rows[0]?.customer_actor_id){
          await client.query(`insert into notification_outbox(case_id,channel,recipient_type,recipient_id,template_key,payload)
            values($1,'push','actor',$2,'deferred_service_reminder',$3)`,[
            row.service_case_id,customer.rows[0].customer_actor_id,JSON.stringify({deferredItemId,repairOrderId:row.repair_order_id,estimatedAmount:row.estimated_amount})
          ]);
        }
      }
    }else if(input.action==='book'){
      if(!['open','reminded'].includes(row.status)||!input.appointmentId) throw httpError('deferred_service_transition_invalid',409);
      const appointment=await client.query(`select id,organization_id,location_id,service_case_id,appointment_status,service_category from roviq_appointments where id=$1 for update`,[input.appointmentId]);
      if(!appointment.rowCount) throw httpError('appointment_not_found',404);
      const a=appointment.rows[0];
      if(a.organization_id!==row.organization_id||(row.location_id&&a.location_id!==row.location_id)) throw httpError('deferred_service_appointment_scope_mismatch',409);
      if(!row.service_case_id) throw httpError('deferred_service_case_required_for_booking',409);
      if(!a.service_case_id||a.service_case_id!==row.service_case_id) throw httpError('deferred_service_appointment_case_mismatch',409);
      if(!['held','confirmed'].includes(a.appointment_status)) throw httpError('deferred_service_appointment_inactive',409);
      if(row.deferred_service_category&&a.service_category&&a.service_category!==row.deferred_service_category){
        throw httpError('deferred_service_appointment_category_mismatch',409);
      }
      nextStatus='booked';
    }else if(input.action==='complete'){
      if(!['booked','open','reminded'].includes(row.status)) throw httpError('deferred_service_transition_invalid',409);
      nextStatus='completed';
    }else if(input.action==='dismiss'){
      if(['completed','dismissed'].includes(row.status)) throw httpError('deferred_service_transition_invalid',409);
      nextStatus='dismissed';
    }else if(input.action==='reopen'){
      if(!['booked','dismissed'].includes(row.status)) throw httpError('deferred_service_transition_invalid',409);
      nextStatus='open';
    }
    const updated=await client.query(`update shop_deferred_service_items set
      status=$2,booked_appointment_id=case when $3='book' then $4::uuid when $3='reopen' then null else booked_appointment_id end,
      next_follow_up_at=case when $5::boolean then $6::timestamptz else next_follow_up_at end,
      follow_up_count=follow_up_count+case when $3='remind' then 1 else 0 end,
      completed_at=case when $2='completed' then now() when $3='reopen' then null else completed_at end,
      dismissed_at=case when $2='dismissed' then now() when $3='reopen' then null else dismissed_at end,
      updated_at=now() where id=$1 returning *`,[
      deferredItemId,nextStatus,input.action,input.appointmentId??null,Object.prototype.hasOwnProperty.call(input,'nextFollowUpAt'),input.nextFollowUpAt??null
    ]);
    await appendEvent(client,row.repair_order_id,`SHOP_OS_DEFERRED_SERVICE_${input.action.toUpperCase()}`,principal,{deferredItemId,status:nextStatus});
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function reconcileRepairOrder(principal:Principal,repairOrderId:string){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const order=await loadOrder(principal,repairOrderId,client,true);
    if(!['completed','closed'].includes(order.status)) throw httpError('repair_order_not_reconcilable',409);
    if(!order.service_case_id) throw httpError('repair_order_case_required',409);
    const openWork=await client.query(`select count(*)::int as n from shop_work_items where repair_order_id=$1 and status not in ('completed','cancelled')`,[repairOrderId]);
    if(Number(openWork.rows[0].n)>0) throw httpError('repair_order_work_incomplete',409);
    const openClocks=await client.query(`select count(*)::int as n from shop_technician_time_entries where repair_order_id=$1 and ended_at is null`,[repairOrderId]);
    if(Number(openClocks.rows[0].n)>0) throw httpError('repair_order_time_open',409);
    const parts=await client.query(`select count(*)::int as n from case_parts_requirements where repair_order_id=$1 and readiness_status not in ('ready','cancelled')`,[repairOrderId]);
    if(Number(parts.rows[0].n)>0) throw httpError('repair_order_parts_unresolved',409);

    const lineTotals=await client.query(`select
      coalesce(sum(case when approval_status='approved' then quantity*unit_price else 0 end),0)::numeric as revenue,
      coalesce(sum(case when approval_status='approved' and line_type<>'labor' then quantity*unit_cost else 0 end),0)::numeric as non_labor_direct_cost
      from shop_repair_order_lines where repair_order_id=$1`,[repairOrderId]);
    const laborByLine=await client.query(`
      select l.id,
        (l.quantity*l.unit_cost)::numeric as estimated_cost,
        count(te.id)::int as tracked_entries,
        coalesce(sum(extract(epoch from (te.ended_at-te.started_at))/3600.0 * te.hourly_cost_snapshot),0)::numeric as tracked_cost
      from shop_repair_order_lines l
      left join shop_work_items wi on wi.repair_order_line_id=l.id
      left join shop_technician_time_entries te on te.work_item_id=wi.id and te.ended_at is not null
      where l.repair_order_id=$1 and l.line_type='labor' and l.approval_status='approved'
      group by l.id,l.quantity,l.unit_cost`,[repairOrderId]);
    const unattributed=await client.query(`
      select coalesce(sum(extract(epoch from (te.ended_at-te.started_at))/3600.0 * te.hourly_cost_snapshot),0)::numeric as tracked_cost
      from shop_technician_time_entries te
      join shop_work_items wi on wi.id=te.work_item_id
      left join shop_repair_order_lines l on l.id=wi.repair_order_line_id
      where te.repair_order_id=$1 and te.ended_at is not null
        and (l.id is null or l.line_type<>'labor' or l.approval_status<>'approved')`,[repairOrderId]);

    const revenue=Number(lineTotals.rows[0].revenue??0);
    const directCost=Number(lineTotals.rows[0].non_labor_direct_cost??0);
    const attributedLaborCost=laborByLine.rows.reduce((sum:number,row:any)=>sum+(Number(row.tracked_entries)>0?Number(row.tracked_cost??0):Number(row.estimated_cost??0)),0);
    const unattributedLaborCost=Number(unattributed.rows[0]?.tracked_cost??0);
    const laborCost=attributedLaborCost+unattributedLaborCost;
    const laborCostSource='per_line_actual_with_estimate_fallback';
    const contribution=revenue-directCost-laborCost;
    const entries=[
      {key:'shop_os_revenue',entryType:'shop_os_revenue',account:'service_revenue',amount:revenue,costCategory:null},
      {key:'shop_os_direct_cost',entryType:'shop_os_direct_cost',account:'service_direct_cost',amount:-Math.abs(directCost),costCategory:'parts_sublet_material'},
      {key:'shop_os_labor_cost',entryType:'shop_os_labor_cost',account:'service_labor_cost',amount:-Math.abs(laborCost),costCategory:'direct_labor'}
    ];
    for(const entry of entries){
      await client.query(`insert into ledger_entries(
        case_id,repair_order_id,entry_type,account_code,amount,currency,state,recognition_basis,cost_category,reconciliation_key,metadata
      ) values($1,$2,$3,$4,$5,'USD','posted','repair_order_completion',$6,$7,$8)
      on conflict(repair_order_id,reconciliation_key) where repair_order_id is not null and reconciliation_key is not null
      do update set amount=excluded.amount,state='posted',recognition_basis=excluded.recognition_basis,cost_category=excluded.cost_category,
        metadata=excluded.metadata`,[
        order.service_case_id,repairOrderId,entry.entryType,entry.account,entry.amount,entry.costCategory,entry.key,
        JSON.stringify({repairOrderNumber:order.repair_order_number,revenue,directCost,laborCost,laborCostSource,attributedLaborCost,unattributedLaborCost,contribution})
      ]);
    }
    await appendEvent(client,repairOrderId,'SHOP_OS_REPAIR_ORDER_RECONCILED',principal,{revenue,directCost,laborCost,laborCostSource,contribution});
    const ledger=await client.query(`select * from ledger_entries where repair_order_id=$1 and reconciliation_key is not null order by reconciliation_key`,[repairOrderId]);
    await client.query('commit');
    return {repairOrderId,revenue,directCost,laborCost,laborCostSource,contribution,ledgerEntries:ledger.rows};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
