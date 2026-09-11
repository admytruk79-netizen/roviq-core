import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { syncCustomerTimeOperationalConstraint } from './case-constraint-projection.js';
import {
  assertUsableShopOsCapacity,
  assertUsableShopOsResource,
  consumeMatchingCaseReservation,
  lockSchedulingCase,
  lockSchedulingResources,
  rebuildShopOsCapacity,
  type CapacityMatch
} from './shop-os-capacity.js';
import { appendAppointmentEvents } from './shop-os-appointment-events.js';
import { loadExistingShopOsResource, loadManageableShopOsResource } from './shop-os-resource-access.js';
import { assertAppointmentInterval, httpError, nextShopOsAppointmentStatus, type ShopOsAppointmentAction } from './shop-os-scheduling-rules.js';
import { rethrowSchedulingError } from './shop-os-scheduling-errors.js';
import { assertBookableServiceCase, assertConfirmableServiceCase, assertManageableServiceCase } from './shop-os-serviceability.js';

export async function updateShopOsAppointment(principal:Principal,appointmentId:string,input:{
  action:ShopOsAppointmentAction;startsAt?:string;endsAt?:string;resourceId?:string;reason?:string|null;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const scheduleFieldsSupplied=input.startsAt!==undefined||input.endsAt!==undefined||input.resourceId!==undefined;
    if(input.action!=='reschedule'&&scheduleFieldsSupplied) throw httpError('schedule_change_requires_reschedule',400);

    const preview=await client.query(`select service_case_id from roviq_appointments where id=$1`,[appointmentId]);
    if(!preview.rowCount) throw httpError('appointment_not_found',404);
    const previewCaseId=preview.rows[0].service_case_id??null;
    await lockSchedulingCase(previewCaseId,client);

    const current=await client.query(`select * from roviq_appointments where id=$1 for update`,[appointmentId]);
    if(!current.rowCount) throw httpError('appointment_not_found',404);
    const existing=current.rows[0];
    if((existing.service_case_id??null)!==previewCaseId) throw httpError('appointment_case_changed',409);

    const existingResource=await loadExistingShopOsResource(principal,existing.resource_id,client);
    await assertManageableServiceCase(principal,existing.service_case_id,existingResource.organization_id,client);
    const nextStatus=nextShopOsAppointmentStatus(existing.appointment_status,input.action);

    let nextResource=existingResource;
    if(input.action==='reschedule') nextResource=await loadManageableShopOsResource(principal,input.resourceId??existing.resource_id,client);
    else if(input.action==='confirm'||input.action==='start') nextResource=await loadManageableShopOsResource(principal,existing.resource_id,client);

    const nextResourceId=input.action==='reschedule'?(input.resourceId??existing.resource_id):existing.resource_id;
    if(existing.service_case_id) await assertManageableServiceCase(principal,existing.service_case_id,nextResource.organization_id,client);
    const nextStarts=input.action==='reschedule'?(input.startsAt??existing.starts_at):existing.starts_at;
    const nextEnds=input.action==='reschedule'?(input.endsAt??existing.ends_at):existing.ends_at;
    assertAppointmentInterval(nextStarts,nextEnds);
    if(input.action==='reschedule'&&(!input.startsAt&&!input.endsAt&&!input.resourceId)) throw httpError('reschedule_change_required',400);

    if(['reschedule','confirm','start'].includes(input.action)){
      await lockSchedulingResources([existing.resource_id,nextResourceId],client);
    }

    let matchedCapacity:CapacityMatch|null=null;
    if(input.action==='reschedule'||input.action==='confirm'){
      matchedCapacity=await assertUsableShopOsCapacity({
        resourceId:nextResourceId,
        sourceConnectionId:nextResource.shop_os_connection_id,
        startsAt:nextStarts,
        endsAt:nextEnds,
        serviceCategory:existing.service_category??null,
        serviceCaseId:existing.service_case_id??null,
        excludeAppointmentId:appointmentId
      },client);
    }else if(input.action==='start'){
      await assertUsableShopOsResource(nextResourceId,nextResource.shop_os_connection_id,client);
    }

    if(input.action==='reschedule'&&nextStatus==='held') await assertBookableServiceCase(existing.service_case_id,client);
    else if(nextStatus==='confirmed'&&(input.action==='confirm'||input.action==='reschedule')) await assertConfirmableServiceCase(existing.service_case_id,client);

    const nextSourceConnectionId=(input.action==='reschedule'||input.action==='confirm'||input.action==='start')
      ? nextResource.shop_os_connection_id
      : existing.source_connection_id;
    const updated=await client.query(`update roviq_appointments
      set resource_id=$1,organization_id=$2,location_id=$3,source_connection_id=$4,appointment_status=$5,
          starts_at=$6,ends_at=$7,released_reason=case when $5 in ('released','cancelled','no_show') then $8 else released_reason end,
          lifecycle_version=lifecycle_version+1,updated_at=now()
      where id=$9 returning *`,[
      nextResourceId,nextResource.organization_id,nextResource.location_id,nextSourceConnectionId,nextStatus,
      nextStarts,nextEnds,input.reason??null,appointmentId
    ]);

    if(matchedCapacity) await consumeMatchingCaseReservation(existing.service_case_id,matchedCapacity.id,client);
    await rebuildShopOsCapacity(existing.resource_id,client);
    if(nextResourceId!==existing.resource_id) await rebuildShopOsCapacity(nextResourceId,client);
    if(existing.service_case_id) await syncCustomerTimeOperationalConstraint(existing.service_case_id,client);

    const row=updated.rows[0];
    await appendAppointmentEvents(client,row,`SHOP_OS_APPOINTMENT_${input.action.toUpperCase()}`,principal,{previousStatus:existing.appointment_status});
    await client.query('commit');
    return row;
  }catch(error){
    await client.query('rollback');
    rethrowSchedulingError(error);
  }finally{
    client.release();
  }
}
