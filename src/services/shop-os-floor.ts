import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { resolveShopPrincipalScope } from './shop-os-scope.js';

type Queryable=Pick<PoolClient,'query'>;
export type WorkItemAction='assign'|'start'|'pause'|'wait_parts'|'wait_customer'|'resume'|'qc'|'complete'|'cancel';

function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

async function resolveScope(principal:Principal,input:{organizationId?:string;locationId?:string},db:Queryable){
  return resolveShopPrincipalScope(principal,input,db);
}

async function loadOrder(principal:Principal,repairOrderId:string,db:Queryable,forUpdate=false){
  const result=await db.query(`select * from shop_repair_orders where id=$1${forUpdate?' for update':''}`,[repairOrderId]);
  if(!result.rowCount) throw httpError('repair_order_not_found',404);
  const row=result.rows[0];
  await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},db);
  return row;
}

async function loadInspection(principal:Principal,inspectionId:string,db:Queryable,forUpdate=false){
  const result=await db.query(`select * from shop_dvi_inspections where id=$1${forUpdate?' for update':''}`,[inspectionId]);
  if(!result.rowCount) throw httpError('dvi_inspection_not_found',404);
  const row=result.rows[0];
  await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},db);
  return row;
}

async function loadWorkItem(principal:Principal,workItemId:string,db:Queryable,forUpdate=false){
  const result=await db.query(`select * from shop_work_items where id=$1${forUpdate?' for update':''}`,[workItemId]);
  if(!result.rowCount) throw httpError('work_item_not_found',404);
  const row=result.rows[0];
  await resolveScope(principal,{organizationId:row.organization_id,locationId:row.location_id},db);
  return row;
}

async function assertActor(actorId:string|null|undefined,organizationId:string,locationId:string|null,db:Queryable){
  if(!actorId)return null;
  const result=await db.query(`select id,organization_id,location_id,status from actors where id=$1`,[actorId]);
  if(!result.rowCount||result.rows[0].status!=='active') throw httpError('shop_floor_actor_not_found',404);
  const actor=result.rows[0];
  if(actor.organization_id!==organizationId) throw httpError('shop_floor_actor_tenant_mismatch',409);
  if(locationId&&actor.location_id&&actor.location_id!==locationId) throw httpError('shop_floor_actor_location_mismatch',409);
  return actor;
}

async function assertResource(resourceId:string|null|undefined,expectedType:'technician'|'bay',organizationId:string,locationId:string|null,actorId:string|null|undefined,db:Queryable){
  if(!resourceId)return null;
  const result=await db.query(`select id,organization_id,location_id,resource_type,active,operational_state,assigned_actor_id from service_resources where id=$1`,[resourceId]);
  if(!result.rowCount||!result.rows[0].active) throw httpError('shop_floor_resource_not_found',404);
  const resource=result.rows[0];
  if(resource.organization_id!==organizationId) throw httpError('shop_floor_resource_tenant_mismatch',409);
  if(locationId&&resource.location_id&&resource.location_id!==locationId) throw httpError('shop_floor_resource_location_mismatch',409);
  if(resource.resource_type!==expectedType) throw httpError('shop_floor_resource_type_mismatch',409);
  if(resource.operational_state==='offline'||resource.operational_state==='blocked') throw httpError('shop_floor_resource_unavailable',409);
  if(expectedType==='technician'&&actorId&&resource.assigned_actor_id&&resource.assigned_actor_id!==actorId){
    throw httpError('technician_resource_actor_mismatch',409);
  }
  return resource;
}

async function appendEvent(db:Queryable,aggregateId:string,eventType:string,principal:Principal,payload:Record<string,unknown>={}){
  await db.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,actor_role,payload)
    values('repair_order',$1,$2,$3,$4,$5)`,[
    aggregateId,eventType,principal.actorId??null,principal.role,JSON.stringify(payload)
  ]);
}

export async function createDviInspection(principal:Principal,input:{
  repairOrderId:string;technicianActorId?:string|null;inspectionType?:string;summary?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const order=await loadOrder(principal,input.repairOrderId,client,true);
    if(['closed','cancelled'].includes(order.status)) throw httpError('repair_order_inactive',409);
    await assertActor(input.technicianActorId,order.organization_id,order.location_id,client);
    const created=await client.query(`insert into shop_dvi_inspections(
      repair_order_id,organization_id,location_id,technician_actor_id,inspection_type,summary,status,started_at,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,'in_progress',now(),$7) returning *`,[
      input.repairOrderId,order.organization_id,order.location_id,input.technicianActorId??order.primary_technician_actor_id??null,
      input.inspectionType??'general',input.summary??null,principal.actorId??null
    ]);
    await appendEvent(client,input.repairOrderId,'SHOP_OS_DVI_STARTED',principal,{inspectionId:created.rows[0].id});
    await client.query('commit');
    return created.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function addDviFinding(principal:Principal,inspectionId:string,input:{
  section:string;item:string;severity:'good'|'attention'|'urgent'|'not_inspected';repairOrderLineId?:string|null;
  measurement?:string|null;technicianNote?:string|null;customerNote?:string|null;sortOrder?:number;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const inspection=await loadInspection(principal,inspectionId,client,true);
    if(!['draft','in_progress'].includes(inspection.status)) throw httpError('dvi_inspection_locked',409);
    if(input.repairOrderLineId){
      const line=await client.query(`select id from shop_repair_order_lines where id=$1 and repair_order_id=$2`,[input.repairOrderLineId,inspection.repair_order_id]);
      if(!line.rowCount) throw httpError('dvi_line_mismatch',409);
    }
    const finding=await client.query(`insert into shop_dvi_findings(
      inspection_id,repair_order_line_id,section,item,severity,measurement,technician_note,customer_note,sort_order
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,[
      inspectionId,input.repairOrderLineId??null,input.section,input.item,input.severity,input.measurement??null,
      input.technicianNote??null,input.customerNote??null,input.sortOrder??0
    ]);
    await appendEvent(client,inspection.repair_order_id,'SHOP_OS_DVI_FINDING_ADDED',principal,{inspectionId,findingId:finding.rows[0].id,severity:input.severity});
    await client.query('commit');
    return finding.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function addDviEvidence(principal:Principal,inspectionId:string,input:{
  findingId?:string|null;mediaType:'photo'|'video'|'document';storageKey:string;mimeType?:string|null;
  caption?:string|null;customerVisible?:boolean;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const inspection=await loadInspection(principal,inspectionId,client,true);
    if(!['draft','in_progress'].includes(inspection.status)) throw httpError('dvi_inspection_locked',409);
    if(input.findingId){
      const finding=await client.query(`select id from shop_dvi_findings where id=$1 and inspection_id=$2`,[input.findingId,inspectionId]);
      if(!finding.rowCount) throw httpError('dvi_finding_mismatch',409);
    }
    const evidence=await client.query(`insert into shop_dvi_evidence(
      inspection_id,finding_id,media_type,storage_key,mime_type,caption,customer_visible,captured_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[
      inspectionId,input.findingId??null,input.mediaType,input.storageKey,input.mimeType??null,input.caption??null,
      input.customerVisible??true,principal.actorId??null
    ]);
    await appendEvent(client,inspection.repair_order_id,'SHOP_OS_DVI_EVIDENCE_ADDED',principal,{inspectionId,evidenceId:evidence.rows[0].id,findingId:input.findingId??null});
    await client.query('commit');
    return evidence.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function submitDviInspection(principal:Principal,inspectionId:string){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const inspection=await loadInspection(principal,inspectionId,client,true);
    if(!['draft','in_progress'].includes(inspection.status)) throw httpError('dvi_transition_invalid',409);
    const count=await client.query(`select count(*)::int as n from shop_dvi_findings where inspection_id=$1`,[inspectionId]);
    if(Number(count.rows[0].n)===0) throw httpError('dvi_findings_required',409);
    const updated=await client.query(`update shop_dvi_inspections set status='submitted',submitted_at=now(),updated_at=now() where id=$1 returning *`,[inspectionId]);
    await appendEvent(client,inspection.repair_order_id,'SHOP_OS_DVI_SUBMITTED',principal,{inspectionId});
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function createWorkItem(principal:Principal,input:{
  repairOrderId:string;repairOrderLineId?:string|null;title:string;description?:string|null;technicianActorId?:string|null;
  technicianResourceId?:string|null;bayResourceId?:string|null;estimatedMinutes?:number|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const order=await loadOrder(principal,input.repairOrderId,client,true);
    if(['closed','cancelled','completed'].includes(order.status)) throw httpError('repair_order_inactive',409);
    if(input.repairOrderLineId){
      const line=await client.query(`select id,approval_status from shop_repair_order_lines where id=$1 and repair_order_id=$2`,[input.repairOrderLineId,input.repairOrderId]);
      if(!line.rowCount) throw httpError('work_item_line_mismatch',409);
      if(line.rows[0].approval_status!=='approved') throw httpError('work_item_line_not_approved',409);
    }
    await assertActor(input.technicianActorId,order.organization_id,order.location_id,client);
    await assertResource(input.technicianResourceId,'technician',order.organization_id,order.location_id,input.technicianActorId,client);
    await assertResource(input.bayResourceId,'bay',order.organization_id,order.location_id,null,client);
    const initialStatus=input.technicianActorId?'assigned':'queued';
    const created=await client.query(`insert into shop_work_items(
      repair_order_id,repair_order_line_id,organization_id,location_id,technician_actor_id,technician_resource_id,
      bay_resource_id,status,title,description,estimated_minutes,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,[
      input.repairOrderId,input.repairOrderLineId??null,order.organization_id,order.location_id,input.technicianActorId??null,
      input.technicianResourceId??null,input.bayResourceId??null,initialStatus,input.title,input.description??null,
      input.estimatedMinutes??null,principal.actorId??null
    ]);
    await appendEvent(client,input.repairOrderId,'SHOP_OS_WORK_ITEM_CREATED',principal,{workItemId:created.rows[0].id,status:initialStatus});
    await client.query('commit');
    return created.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

const workTransitions:Record<WorkItemAction,Record<string,string>>={
  assign:{queued:'assigned',assigned:'assigned',paused:'assigned'},
  start:{assigned:'in_progress',paused:'in_progress'},
  pause:{in_progress:'paused'},
  wait_parts:{in_progress:'waiting_parts'},
  wait_customer:{in_progress:'waiting_customer'},
  resume:{waiting_parts:'in_progress',waiting_customer:'in_progress',paused:'in_progress'},
  qc:{in_progress:'quality_control'},
  complete:{quality_control:'completed'},
  cancel:{queued:'cancelled',assigned:'cancelled',in_progress:'cancelled',paused:'cancelled',waiting_parts:'cancelled',waiting_customer:'cancelled',quality_control:'cancelled'}
};

async function closeOpenTimeForWorkItem(workItemId:string,reason:'pause'|'complete'|'manual'|'cancel',db:Queryable){
  await db.query(`update shop_technician_time_entries set ended_at=now(),end_reason=$2
    where work_item_id=$1 and ended_at is null`,[workItemId,reason]);
}

export async function updateWorkItem(principal:Principal,workItemId:string,input:{
  action:WorkItemAction;technicianActorId?:string|null;technicianResourceId?:string|null;bayResourceId?:string|null;blockedReason?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const item=await loadWorkItem(principal,workItemId,client,true);
    const next=workTransitions[input.action][item.status];
    if(!next) throw httpError('work_item_transition_invalid',409);
    const technicianActorId=input.technicianActorId!==undefined?input.technicianActorId:item.technician_actor_id;
    const technicianResourceId=input.technicianResourceId!==undefined?input.technicianResourceId:item.technician_resource_id;
    const bayResourceId=input.bayResourceId!==undefined?input.bayResourceId:item.bay_resource_id;
    await assertActor(technicianActorId,item.organization_id,item.location_id,client);
    await assertResource(technicianResourceId,'technician',item.organization_id,item.location_id,technicianActorId,client);
    await assertResource(bayResourceId,'bay',item.organization_id,item.location_id,null,client);
    if(['assign','start','resume'].includes(input.action)&&!technicianActorId) throw httpError('technician_required',409);
    if(['pause','wait_parts','wait_customer','qc','complete','cancel'].includes(input.action)){
      const endReason=input.action==='complete'?'complete':input.action==='cancel'?'cancel':'pause';
      await closeOpenTimeForWorkItem(workItemId,endReason,client);
    }
    const updated=await client.query(`update shop_work_items set
      status=$2,technician_actor_id=$3,technician_resource_id=$4,bay_resource_id=$5,
      blocked_reason=case when $2 in ('waiting_parts','waiting_customer','paused') then $6 else null end,
      started_at=case when $2='in_progress' then coalesce(started_at,now()) else started_at end,
      completed_at=case when $2='completed' then now() else completed_at end,
      updated_at=now() where id=$1 returning *`,[
      workItemId,next,technicianActorId??null,technicianResourceId??null,bayResourceId??null,input.blockedReason??null
    ]);
    await appendEvent(client,item.repair_order_id,`SHOP_OS_WORK_ITEM_${input.action.toUpperCase()}`,principal,{workItemId,status:next});
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function clockTechnicianIn(principal:Principal,workItemId:string,input:{
  technicianActorId?:string;technicianResourceId?:string|null;notes?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const item=await loadWorkItem(principal,workItemId,client,true);
    if(!['assigned','in_progress','paused'].includes(item.status)) throw httpError('technician_clock_state_invalid',409);
    const technicianActorId=input.technicianActorId??item.technician_actor_id;
    if(!technicianActorId) throw httpError('technician_required',409);
    const technicianResourceId=input.technicianResourceId!==undefined?input.technicianResourceId:item.technician_resource_id;
    await assertActor(technicianActorId,item.organization_id,item.location_id,client);
    await assertResource(technicianResourceId,'technician',item.organization_id,item.location_id,technicianActorId,client);
    const open=await client.query(`select id,work_item_id from shop_technician_time_entries where technician_actor_id=$1 and ended_at is null for update`,[technicianActorId]);
    if(open.rowCount) throw httpError('technician_already_clocked_in',409);
    const created=await client.query(`insert into shop_technician_time_entries(
      work_item_id,repair_order_id,organization_id,location_id,technician_actor_id,technician_resource_id,notes,created_by_actor_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[
      workItemId,item.repair_order_id,item.organization_id,item.location_id,technicianActorId,technicianResourceId??null,input.notes??null,principal.actorId??null
    ]);
    await client.query(`update shop_work_items set status='in_progress',technician_actor_id=$2,technician_resource_id=$3,
      started_at=coalesce(started_at,now()),blocked_reason=null,updated_at=now() where id=$1`,[
      workItemId,technicianActorId,technicianResourceId??null
    ]);
    await appendEvent(client,item.repair_order_id,'SHOP_OS_TECHNICIAN_CLOCK_IN',principal,{workItemId,timeEntryId:created.rows[0].id,technicianActorId});
    await client.query('commit');
    return created.rows[0];
  }catch(error){
    await client.query('rollback');
    if((error as {code?:string})?.code==='23505') throw httpError('technician_already_clocked_in',409);
    throw error;
  }finally{client.release();}
}

export async function clockTechnicianOut(principal:Principal,workItemId:string,input:{endReason?:'pause'|'complete'|'switch'|'manual';notes?:string|null}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const item=await loadWorkItem(principal,workItemId,client,true);
    const current=await client.query(`select * from shop_technician_time_entries where work_item_id=$1 and ended_at is null order by started_at desc limit 1 for update`,[workItemId]);
    if(!current.rowCount) throw httpError('technician_not_clocked_in',409);
    const updated=await client.query(`update shop_technician_time_entries set ended_at=now(),end_reason=$2,
      notes=case when $3::text is null then notes else $3 end where id=$1 returning *`,[
      current.rows[0].id,input.endReason??'manual',input.notes??null
    ]);
    if(input.endReason==='pause') await client.query(`update shop_work_items set status='paused',updated_at=now() where id=$1 and status='in_progress'`,[workItemId]);
    await appendEvent(client,item.repair_order_id,'SHOP_OS_TECHNICIAN_CLOCK_OUT',principal,{workItemId,timeEntryId:updated.rows[0].id,endReason:input.endReason??'manual'});
    await client.query('commit');
    return updated.rows[0];
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

export async function getShopFloor(principal:Principal,repairOrderId:string){
  const client=await pool.connect();
  try{
    const order=await loadOrder(principal,repairOrderId,client,false);
    const [inspections,findings,evidence,workItems,timeEntries]=await Promise.all([
      client.query(`select * from shop_dvi_inspections where repair_order_id=$1 order by created_at,id`,[repairOrderId]),
      client.query(`select f.* from shop_dvi_findings f join shop_dvi_inspections i on i.id=f.inspection_id where i.repair_order_id=$1 order by f.sort_order,f.id`,[repairOrderId]),
      client.query(`select e.* from shop_dvi_evidence e join shop_dvi_inspections i on i.id=e.inspection_id where i.repair_order_id=$1 order by e.created_at,e.id`,[repairOrderId]),
      client.query(`select * from shop_work_items where repair_order_id=$1 order by created_at,id`,[repairOrderId]),
      client.query(`select * from shop_technician_time_entries where repair_order_id=$1 order by started_at,id`,[repairOrderId])
    ]);
    const laborMinutes=timeEntries.rows.reduce((sum,row)=>{
      const end=row.ended_at?new Date(row.ended_at).getTime():Date.now();
      const start=new Date(row.started_at).getTime();
      return sum+Math.max(0,Math.round((end-start)/60000));
    },0);
    return {
      repairOrder:order,inspections:inspections.rows,findings:findings.rows,evidence:evidence.rows,
      workItems:workItems.rows,timeEntries:timeEntries.rows,
      summary:{
        inspectionCount:inspections.rowCount??inspections.rows.length,
        submittedInspections:inspections.rows.filter((row)=>row.status==='submitted').length,
        urgentFindings:findings.rows.filter((row)=>row.severity==='urgent').length,
        openWorkItems:workItems.rows.filter((row)=>!['completed','cancelled'].includes(row.status)).length,
        activeClocks:timeEntries.rows.filter((row)=>!row.ended_at).length,
        laborMinutes
      }
    };
  }finally{client.release();}
}
