import type { Principal } from '../types/principal.js';
import type { Queryable } from './shop-os-scheduling-rules.js';

export async function appendAppointmentEvents(
  db:Queryable,
  row:any,
  eventType:string,
  principal:Principal,
  payload:Record<string,unknown>={}
){
  if(row.service_case_id){
    await db.query(`insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
      values('service_case',$1,$2,$3,$4)`,[
      row.service_case_id,eventType,principal.actorId??null,
      JSON.stringify({appointmentId:row.id,resourceId:row.resource_id,status:row.appointment_status,...payload})
    ]);
  }
  if(row.source_connection_id){
    await db.query(`insert into integration_sync_events(connection_id,event_type,direction,status,roviq_entity_type,roviq_entity_id,payload)
      values($1,$2,'internal','accepted','appointment',$3,$4)`,[
      row.source_connection_id,eventType.toLowerCase(),row.id,
      JSON.stringify({serviceCaseId:row.service_case_id??null,resourceId:row.resource_id,status:row.appointment_status,...payload})
    ]);
  }
}
