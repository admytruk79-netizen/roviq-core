export type ShopWaitlistState='waiting'|'offered'|'booked'|'expired'|'cancelled';

export type ShopWaitlistEntryModel={
  state:ShopWaitlistState;
  booked_appointment_id?:string|null;
};

export type WaitlistEligibilityEntry={
  service_case_id?:string|null;
  requested_service_category?:string|null;
  requested_after?:string|null;
  requested_before?:string|null;
  estimated_duration_minutes?:number|null;
  preferred_resource_types?:string[];
};
export type WaitlistEligibilityAppointment={
  id:string;
  service_case_id?:string|null;
  appointment_status:string;
  starts_at:string;
  ends_at:string;
  service_category?:string|null;
  resource_id?:string|null;
};
export type WaitlistEligibilityResource={id:string;resource_type:string};

export function canCancelWaitlistEntry(entry:ShopWaitlistEntryModel){
  return entry.state==='waiting'||entry.state==='offered';
}

export function bookedAppointmentText(entry:ShopWaitlistEntryModel){
  if(entry.state!=='booked') return null;
  return entry.booked_appointment_id?`Booked · ${entry.booked_appointment_id}`:'Booked';
}

export function appointmentEligibleForWaitlist(entry:WaitlistEligibilityEntry,appointment:WaitlistEligibilityAppointment,resources:Map<string,WaitlistEligibilityResource>){
  if(!['held','confirmed'].includes(appointment.appointment_status))return false;
  if((appointment.service_case_id??null)!==(entry.service_case_id??null))return false;
  if(entry.requested_service_category&&appointment.service_category!==entry.requested_service_category)return false;
  const startsAt=new Date(appointment.starts_at).getTime(),endsAt=new Date(appointment.ends_at).getTime();
  if(!Number.isFinite(startsAt)||!Number.isFinite(endsAt)||endsAt<=startsAt)return false;
  if(entry.requested_after&&startsAt<new Date(entry.requested_after).getTime())return false;
  if(entry.requested_before&&endsAt>new Date(entry.requested_before).getTime())return false;
  if(entry.estimated_duration_minutes&&(endsAt-startsAt)/60000<entry.estimated_duration_minutes)return false;
  if(entry.preferred_resource_types?.length){
    const resource=appointment.resource_id?resources.get(appointment.resource_id):undefined;
    if(!resource||!entry.preferred_resource_types.includes(resource.resource_type))return false;
  }
  return true;
}

export function selectedAppointmentStillEligible(selectedId:string|undefined,appointments:WaitlistEligibilityAppointment[]){
  return Boolean(selectedId&&appointments.some(appointment=>appointment.id===selectedId));
}
