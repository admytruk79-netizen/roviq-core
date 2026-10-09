import { assertLocalShopContext } from './shop-os-local-intake.js';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';
import { syncCustomerTimeOperationalConstraint } from './case-constraint-projection.js';
import {
  assertUsableShopOsCapacity,
  consumeMatchingCaseReservation,
  lockSchedulingCase,
  lockSchedulingResources,
  rebuildShopOsCapacity
} from './shop-os-capacity.js';
import { appendAppointmentEvents } from './shop-os-appointment-events.js';
import { loadManageableShopOsResource } from './shop-os-resource-access.js';
import { assertAppointmentInterval, httpError } from './shop-os-scheduling-rules.js';
import { rethrowSchedulingError } from './shop-os-scheduling-errors.js';
import { assertBookableServiceCase, assertConfirmableServiceCase, assertManageableServiceCase } from './shop-os-serviceability.js';

export async function createShopOsAppointment(principal:Principal,input:{
  shopCustomerId?:string|null;shopVehicleId?:string|null;
  serviceCaseId?:string|null;resourceId:string;startsAt:string;endsAt:string;serviceCategory?:string|null;
  status?:'held'|'confirmed';customerVisibleSummary?:string|null;internalNotes?:string|null;recoverySourceAppointmentId?:string;
}){
  const client=await pool.connect();
  try{
    await client.query('begin');
    assertAppointmentInterval(input.startsAt,input.endsAt);
    await lockSchedulingCase(input.serviceCaseId,client);

    let recoverySource:any=null;
    if(input.recoverySourceAppointmentId){
      const source=await client.query(`select * from roviq_appointments where id=$1 for update`,[input.recoverySourceAppointmentId]);
      if(!source.rowCount) throw httpError('recovery_source_appointment_not_found',404);
      recoverySource=source.rows[0];
      if(recoverySource.shop_customer_id){
        if(input.shopCustomerId&&input.shopCustomerId!==recoverySource.shop_customer_id)throw httpError('recovery_source_customer_mismatch',409);
        if(input.shopVehicleId&&input.shopVehicleId!==recoverySource.shop_vehicle_id)throw httpError('recovery_source_vehicle_mismatch',409);
        input={...input,shopCustomerId:recoverySource.shop_customer_id,shopVehicleId:recoverySource.shop_vehicle_id};
      }else if(input.shopCustomerId)throw httpError('recovery_source_customer_mismatch',409);
      if(recoverySource.recovery_source_appointment_id) throw httpError('shop_os_recovery_source_not_root',409);
      if(!['cancelled','no_show'].includes(recoverySource.appointment_status)) throw httpError('recovery_source_not_terminal',409);
      if((recoverySource.service_case_id??null)!==(input.serviceCaseId??null)) throw httpError('recovery_source_case_mismatch',409);
      const satisfyingReplacement=await client.query(`
        select id from roviq_appointments
        where recovery_source_appointment_id=$1
          and appointment_status in ('held','confirmed','in_progress','completed')
        order by created_at asc,id asc limit 1`,[input.recoverySourceAppointmentId]);
      if(satisfyingReplacement.rowCount) throw httpError('appointment_recovery_already_exists',409);
    }

    const resource=await loadManageableShopOsResource(principal,input.resourceId,client);
    if(input.shopCustomerId&&input.serviceCaseId)throw httpError('shop_local_context_conflict',409);
    await assertLocalShopContext(principal,input,{organizationId:resource.organization_id,locationId:resource.location_id},client);
    await assertManageableServiceCase(principal,input.serviceCaseId,resource.organization_id,client);
    if(recoverySource){
      if(recoverySource.organization_id!==resource.organization_id) throw httpError('recovery_source_tenant_mismatch',409);
      if(recoverySource.location_id&&resource.location_id&&recoverySource.location_id!==resource.location_id){
        throw httpError('recovery_source_location_mismatch',409);
      }
    }

    await lockSchedulingResources([input.resourceId],client);
    const capacity=await assertUsableShopOsCapacity({
      resourceId:input.resourceId,
      sourceConnectionId:resource.shop_os_connection_id,
      startsAt:input.startsAt,
      endsAt:input.endsAt,
      serviceCategory:input.serviceCategory??null,
      serviceCaseId:input.serviceCaseId??null
    },client);

    const requestedStatus=input.status??'held';
    if(requestedStatus==='confirmed') await assertConfirmableServiceCase(input.serviceCaseId,client);
    else await assertBookableServiceCase(input.serviceCaseId,client);

    const created=await client.query(`insert into roviq_appointments(
      service_case_id,organization_id,location_id,resource_id,source_connection_id,appointment_status,
      starts_at,ends_at,service_category,customer_visible_summary,internal_notes,created_by_actor_id,recovery_source_appointment_id,shop_customer_id,shop_vehicle_id
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,[
      input.serviceCaseId??null,resource.organization_id,resource.location_id,input.resourceId,resource.shop_os_connection_id,
      requestedStatus,input.startsAt,input.endsAt,input.serviceCategory??null,input.customerVisibleSummary??null,input.internalNotes??null,
      principal.actorId??null,input.recoverySourceAppointmentId??null,input.shopCustomerId??null,input.shopVehicleId??null
    ]);
    const row=created.rows[0];

    await consumeMatchingCaseReservation(input.serviceCaseId,capacity.id,client);
    await rebuildShopOsCapacity(input.resourceId,client);
    if(input.serviceCaseId) await syncCustomerTimeOperationalConstraint(input.serviceCaseId,client);
    await appendAppointmentEvents(
      client,row,row.appointment_status==='confirmed'?'SHOP_OS_APPOINTMENT_CONFIRMED':'SHOP_OS_APPOINTMENT_HELD',principal,
      input.recoverySourceAppointmentId?{recoverySourceAppointmentId:input.recoverySourceAppointmentId}:{}
    );
    await client.query('commit');
    return row;
  }catch(error){
    await client.query('rollback');
    rethrowSchedulingError(error);
  }finally{
    client.release();
  }
}
