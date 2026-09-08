export type RecoverableAppointment={
  id:string;
  resource_id:string|null;
  service_case_id?:string|null;
  appointment_status:string;
  starts_at:string;
  ends_at:string;
  service_category?:string|null;
  customer_visible_summary?:string|null;
};

export function isRecoverableAppointment(appointment:RecoverableAppointment){
  return appointment.appointment_status==='cancelled'||appointment.appointment_status==='no_show';
}

export function defaultRecoveryWindow(appointment:RecoverableAppointment,nowMs=Date.now()){
  const originalStart=new Date(appointment.starts_at).getTime();
  const originalEnd=new Date(appointment.ends_at).getTime();
  const duration=Math.max(Number.isFinite(originalEnd-originalStart)?originalEnd-originalStart:0,15*60_000);
  const earliest=nowMs+30*60_000;
  const rounded=Math.ceil(earliest/(30*60_000))*(30*60_000);
  const start=Number.isFinite(originalStart)&&originalStart>=earliest?originalStart:rounded;
  return {startsAt:new Date(start).toISOString(),endsAt:new Date(start+duration).toISOString()};
}

export function replacementAppointmentBody(
  appointment:RecoverableAppointment,
  resourceId:string,
  startsAt:string,
  endsAt:string
){
  return {
    serviceCaseId:appointment.service_case_id??null,
    resourceId,
    startsAt,
    endsAt,
    serviceCategory:appointment.service_category??null,
    status:'held' as const,
    customerVisibleSummary:appointment.customer_visible_summary??null,
    internalNotes:`Replacement appointment for ${appointment.appointment_status} appointment ${appointment.id}`
  };
}
