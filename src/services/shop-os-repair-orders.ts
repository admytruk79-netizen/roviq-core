import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { assertCaseAccess } from './case-access.js';

type Queryable=Pick<PoolClient,'query'>;
export type RepairOrderStatus='draft'|'estimate_pending'|'awaiting_approval'|'approved'|'in_progress'|'waiting_parts'|'waiting_customer'|'quality_control'|'completed'|'closed'|'cancelled';
export type RepairOrderAction='submit_estimate'|'revise_estimate'|'approve'|'start'|'wait_parts'|'wait_customer'|'resume'|'qc'|'complete'|'close'|'cancel';
export type RepairOrderLineType='labor'|'part'|'fee'|'sublet';
export type RepairOrderLineApproval='pending'|'approved'|'declined'|'deferred';

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

async function resolveScope(principal:Principal,input:{organizationId?:string;locationId?:string},db:Queryable){
  if(principal.role==='admin'){
    if(!input.organizationId) throw httpError('organization_id_required',400);
    return {organizationId:input.organizationId,locationId:input.locationId??null};
  }
  if(principal.role!=='partner'||!principal.actorId) throw httpError('forbidden',403);
  const actor=await db.query(`select organization_id,location_id from actors where id=$1 and status='active'`,[principal.actorId]);
  if(!actor.rowCount||!actor.rows[0].organization_id) throw httpError('forbidden',403);
  const organizationId=actor.rows[0].organization_id as string;
  const actorLocationId=actor.rows[0].location_id as string|null;
  if(input.organizationId&&input.organizationId!==organizationId) throw httpError('forbidden',403);
  if(actorLocationId&&input.locationId&&input.locationId!==actorLocationId) throw httpError('forbidden',403);
  return {organizationId,locationId:actorLocationId??input.locationId??null};
}

async function assertCaseBelongsToShop(principal:Principal,caseId:string|null|undefined,organizationId:string,db:Queryable){
  if(!caseId)return;
  try{ await assertCaseAccess(principal,caseId,db); }
  catch(error){
    if(error instanceof Error&&error.message==='case_not_found') throw httpError('service_case_not_found',404);
    if(error instanceof Error&&error.message==='forbidden') throw httpError('forbidden',403);
    throw error;
  }
  const linked=await db.query(`select (
    exists(select 1 from service_cases sc join actors a on a.id=sc.current_owner_actor_id where sc.id=$1 and a.organization_id=$2)
    or exists(select 1 from matches_offers mo join actors a on a.id=mo.actor_id where mo.case_id=$1 and a.organization_id=$2)
  ) as linked`,[caseId,organizationId]);
  if(!linked.rows[0]?.linked) throw httpError('service_case_tenant_mismatch',409);
}

async function assertActorScope(actorId:string|null|undefined,organizationId:string,locationId:string|null,db:Queryable){
  if(!actorId)return;
  const actor=await db.query(`select organization_id,location_id,status from actors where id=$1`,[actorId]);
  if(!actor.rowCount||actor.rows[0].status!=='active') throw httpError('repair_order_actor_not_found',404);
  if(actor.rows[0].organization_id!==organizationId) throw httpError('repair_order_actor_tenant_mismatch',409);
  if(locationId&&actor.rows[0].location_id&&actor.rows[0].location_id!==locationId) throw httpError('repair_order_actor_location_mismatch',409);
}

async function loadOrderForUpdate(principal:Principal,repairOrderId:string,db:Queryable){
  const result=await db.query(`select * from shop_repair_orders where id=$1 for update`,[repairOrderId]);
  if(!result.rowCount) throw httpError('repair_order_not_found',404);
  const row=result.rows[0];
  await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},db);
  return row;
}

async function appendOrderEvent(db:Queryable,orderId:string,eventType:string,principal:Principal,payload:Record<string,unknown>={}){
  await db.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload)
    values('repair_order',$1,$2,$3,$4,$5)`,[
    orderId,eventType,principal.actorId??null,principal.role,JSON.stringify(payload)
  ]);
}

async function recalculateTotals(repairOrderId:string,db:Queryable){
  const totals=await db.query(`select
      coalesce(sum(quantity*unit_price),0)::numeric(12,2) as subtotal,
      coalesce(sum(case when approval_status='approved' then quantity*unit_price else 0 end),0)::numeric(12,2) as approved
    from shop_repair_order_lines where repair_order_id=$1`,[repairOrderId]);
  return (await db.query(`update shop_repair_orders set
      subtotal_amount=$2,total_amount=$2+tax_amount,approved_amount=$3,updated_at=now()
      where id=$1 returning *`,[repairOrderId,totals.rows[0].subtotal,totals.rows[0].approved])).rows[0];
}

export async function createRepairOrder(principal:Principal,input:{
  organizationId?:string;locationId?:string;serviceCaseId?:string|null;appointmentId?:string|null;
  customerVehicleId?:string|null;advisorActorId?:string|null;primaryTechnicianActorId?:string|null;
  customerConcern?:string|null;internalNotes?:string|null;odometer?:number|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const scope=await resolveScope(principal,input,client);
    await assertCaseBelongsToShop(principal,input.serviceCaseId,scope.organizationId,client);
    await assertActorScope(input.advisorActorId,scope.organizationId,scope.locationId,client);
    await assertActorScope(input.primaryTechnicianActorId,scope.organizationId,scope.locationId,client);
    if(input.appointmentId){
      const appointment=await client.query(`select organization_id,location_id,service_case_id,appointment_status from roviq_appointments where id=$1`,[input.appointmentId]);
      if(!appointment.rowCount) throw httpError('appointment_not_found',404);
      const a=appointment.rows[0];
      if(a.organization_id!==scope.organizationId) throw httpError('repair_order_appointment_tenant_mismatch',409);
      if(scope.locationId&&a.location_id!==scope.locationId) throw httpError('repair_order_appointment_location_mismatch',409);
      if((a.service_case_id??null)!==(input.serviceCaseId??null)) throw httpError('repair_order_appointment_case_mismatch',409);
      if(!['held','confirmed','in_progress','completed'].includes(a.appointment_status)) throw httpError('repair_order_appointment_inactive',409);
    }
    if(input.customerVehicleId){
      const vehicle=await client.query(`select id from customer_vehicles where id=$1`,[input.customerVehicleId]);
      if(!vehicle.rowCount) throw httpError('customer_vehicle_not_found',404);
    }
    const created=await client.query(`insert into shop_repair_orders(
      organization_id,location_id,service_case_id,appointment_id,customer_vehicle_id,advisor_actor_id,
      primary_technician_actor_id,repair_order_number,customer_concern,internal_notes,odometer,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,'RO-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),$8,$9,$10,$11)
    returning *`,[
      scope.organizationId,scope.locationId,input.serviceCaseId??null,input.appointmentId??null,input.customerVehicleId??null,
      input.advisorActorId??null,input.primaryTechnicianActorId??null,input.customerConcern??null,input.internalNotes??null,
      input.odometer??null,principal.actorId??null
    ]);
    await appendOrderEvent(client,created.rows[0].id,'SHOP_OS_REPAIR_ORDER_CREATED',principal,{status:'draft'});
    await client.query('commit');
    return created.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function listRepairOrders(principal:Principal,input:{organizationId?:string;locationId?:string;statuses?:RepairOrderStatus[]}){
  const client=await pool.connect();
  try{
    const scope=await resolveScope(principal,input,client);
    const result=await client.query(`select * from shop_repair_orders
      where organization_id=$1 and ($2::uuid is null or location_id=$2::uuid)
        and ($3::text[] is null or status=any($3::text[]))
      order by updated_at desc,id desc`,[scope.organizationId,scope.locationId,input.statuses?.length?input.statuses:null]);
    return {scope,repairOrders:result.rows};
  }finally{client.release();}
}

export async function getRepairOrder(principal:Principal,repairOrderId:string){
  const client=await pool.connect();
  try{
    const result=await client.query(`select * from shop_repair_orders where id=$1`,[repairOrderId]);
    if(!result.rowCount) throw httpError('repair_order_not_found',404);
    const order=result.rows[0];
    await resolveScope(principal,{organizationId:order.organization_id,locationId:order.location_id},client);
    const lines=await client.query(`select * from shop_repair_order_lines where repair_order_id=$1 order by sort_order,id`,[repairOrderId]);
    return {repairOrder:order,lines:lines.rows};
  }finally{client.release();}
}

export async function addRepairOrderLine(principal:Principal,repairOrderId:string,input:{
  lineType:RepairOrderLineType;description:string;serviceCategory?:string|null;quantity?:number;unitPrice?:number;
  unitCost?:number;laborHours?:number|null;taxable?:boolean;sortOrder?:number;metadata?:Record<string,unknown>;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const order=await loadOrderForUpdate(principal,repairOrderId,client);
    if(!['draft','estimate_pending'].includes(order.status)) throw httpError('repair_order_lines_locked',409);
    const line=await client.query(`insert into shop_repair_order_lines(
      repair_order_id,line_type,description,service_category,quantity,unit_price,unit_cost,labor_hours,taxable,sort_order,metadata
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,[
      repairOrderId,input.lineType,input.description,input.serviceCategory??null,input.quantity??1,input.unitPrice??0,input.unitCost??0,
      input.laborHours??null,input.taxable??true,input.sortOrder??0,JSON.stringify(input.metadata??{})
    ]);
    const updatedOrder=await recalculateTotals(repairOrderId,client);
    await appendOrderEvent(client,repairOrderId,'SHOP_OS_REPAIR_ORDER_LINE_ADDED',principal,{lineId:line.rows[0].id});
    await client.query('commit');
    return {repairOrder:updatedOrder,line:line.rows[0]};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function updateRepairOrderLine(principal:Principal,repairOrderId:string,lineId:string,input:{
  approvalStatus?:RepairOrderLineApproval;description?:string;quantity?:number;unitPrice?:number;unitCost?:number;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const order=await loadOrderForUpdate(principal,repairOrderId,client);
    const line=await client.query(`select * from shop_repair_order_lines where id=$1 and repair_order_id=$2 for update`,[lineId,repairOrderId]);
    if(!line.rowCount) throw httpError('repair_order_line_not_found',404);
    const pricingChange=input.description!==undefined||input.quantity!==undefined||input.unitPrice!==undefined||input.unitCost!==undefined;
    if(pricingChange&&!['draft','estimate_pending'].includes(order.status)) throw httpError('repair_order_lines_locked',409);
    if(input.approvalStatus!==undefined&&!['awaiting_approval','approved'].includes(order.status)) throw httpError('line_approval_not_allowed',409);
    const updatedLine=await client.query(`update shop_repair_order_lines set
      description=coalesce($3,description),quantity=coalesce($4,quantity),unit_price=coalesce($5,unit_price),unit_cost=coalesce($6,unit_cost),
      approval_status=coalesce($7,approval_status),
      approved_at=case when $7='approved' then now() when $7 is not null then null else approved_at end,
      declined_at=case when $7='declined' then now() when $7 is not null then null else declined_at end,
      deferred_at=case when $7='deferred' then now() when $7 is not null then null else deferred_at end,
      updated_at=now() where id=$1 and repair_order_id=$2 returning *`,[
      lineId,repairOrderId,input.description??null,input.quantity??null,input.unitPrice??null,input.unitCost??null,input.approvalStatus??null
    ]);
    const updatedOrder=await recalculateTotals(repairOrderId,client);
    await appendOrderEvent(client,repairOrderId,'SHOP_OS_REPAIR_ORDER_LINE_UPDATED',principal,{lineId,approvalStatus:input.approvalStatus??undefined});
    await client.query('commit');
    return {repairOrder:updatedOrder,line:updatedLine.rows[0]};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

const transitions:Record<RepairOrderAction,Partial<Record<RepairOrderStatus,RepairOrderStatus>>>= {
  submit_estimate:{draft:'awaiting_approval',estimate_pending:'awaiting_approval'},
  revise_estimate:{awaiting_approval:'estimate_pending',approved:'estimate_pending'},
  approve:{awaiting_approval:'approved'},
  start:{approved:'in_progress'},
  wait_parts:{in_progress:'waiting_parts'},
  wait_customer:{in_progress:'waiting_customer'},
  resume:{waiting_parts:'in_progress',waiting_customer:'in_progress'},
  qc:{in_progress:'quality_control'},
  complete:{quality_control:'completed'},
  close:{completed:'closed'},
  cancel:{draft:'cancelled',estimate_pending:'cancelled',awaiting_approval:'cancelled',approved:'cancelled',in_progress:'cancelled',waiting_parts:'cancelled',waiting_customer:'cancelled',quality_control:'cancelled'}
};

export async function updateRepairOrder(principal:Principal,repairOrderId:string,input:{
  action:RepairOrderAction;advisorActorId?:string|null;primaryTechnicianActorId?:string|null;internalNotes?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const order=await loadOrderForUpdate(principal,repairOrderId,client);
    const next=transitions[input.action][order.status as RepairOrderStatus];
    if(!next) throw httpError('repair_order_transition_invalid',409);
    await assertActorScope(input.advisorActorId,order.organization_id,order.location_id,client);
    await assertActorScope(input.primaryTechnicianActorId,order.organization_id,order.location_id,client);
    if(input.action==='submit_estimate'){
      const count=await client.query(`select count(*)::int as n from shop_repair_order_lines where repair_order_id=$1`,[repairOrderId]);
      if(Number(count.rows[0].n)===0) throw httpError('repair_order_lines_required',409);
    }
    if(input.action==='approve'){
      const pending=await client.query(`select
        count(*) filter(where approval_status='pending')::int as pending,
        count(*) filter(where approval_status='approved')::int as approved
        from shop_repair_order_lines where repair_order_id=$1`,[repairOrderId]);
      if(Number(pending.rows[0].pending)>0) throw httpError('repair_order_line_approval_pending',409);
      if(Number(pending.rows[0].approved)===0) throw httpError('repair_order_no_approved_work',409);
    }
    if(input.action==='revise_estimate'){
      await client.query(`update shop_repair_order_lines set approval_status='pending',approved_at=null,declined_at=null,deferred_at=null,updated_at=now() where repair_order_id=$1`,[repairOrderId]);
    }
    const updated=await client.query(`update shop_repair_orders set
      status=$2,
      advisor_actor_id=case when $3::boolean then $4::uuid else advisor_actor_id end,
      primary_technician_actor_id=case when $5::boolean then $6::uuid else primary_technician_actor_id end,
      internal_notes=case when $7::boolean then $8::text else internal_notes end,
      estimate_version=case when $9='revise_estimate' then estimate_version+1 else estimate_version end,
      approved_at=case when $9='approve' then now() else approved_at end,
      started_at=case when $9='start' then now() else started_at end,
      completed_at=case when $9='complete' then now() else completed_at end,
      closed_at=case when $9='close' then now() else closed_at end,
      cancelled_at=case when $9='cancel' then now() else cancelled_at end,
      updated_at=now()
      where id=$1 returning *`,[
      repairOrderId,next,
      Object.prototype.hasOwnProperty.call(input,'advisorActorId'),input.advisorActorId??null,
      Object.prototype.hasOwnProperty.call(input,'primaryTechnicianActorId'),input.primaryTechnicianActorId??null,
      Object.prototype.hasOwnProperty.call(input,'internalNotes'),input.internalNotes??null,input.action
    ]);
    const recalculated=input.action==='revise_estimate'?await recalculateTotals(repairOrderId,client):updated.rows[0];
    await appendOrderEvent(client,repairOrderId,`SHOP_OS_REPAIR_ORDER_${input.action.toUpperCase()}`,principal,{previousStatus:order.status,status:next});
    await client.query('commit');
    return recalculated;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
