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
