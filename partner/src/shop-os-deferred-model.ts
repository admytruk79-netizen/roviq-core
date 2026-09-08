export type DeferredServiceItem={
  id:string;
  status:'open'|'reminded'|'booked'|'completed'|'dismissed';
  service_case_id?:string|null;
  line_description?:string|null;
  service_category?:string|null;
  severity?:'recommended'|'attention'|'urgent';
  reason?:string|null;
  estimated_amount?:string|number|null;
  target_return_at?:string|null;
  next_follow_up_at?:string|null;
  follow_up_count?:number;
  booked_appointment_id?:string|null;
};

export type DeferredAppointment={
  id:string;
  service_case_id?:string|null;
  appointment_status:string;
  starts_at:string;
  ends_at:string;
  service_category?:string|null;
};

export function eligibleDeferredAppointments(item:DeferredServiceItem,appointments:DeferredAppointment[]){
  if(!item.service_case_id)return [];
  return appointments.filter(appointment=>
    appointment.service_case_id===item.service_case_id&&
    ['held','confirmed'].includes(appointment.appointment_status)&&
    (!item.service_category||!appointment.service_category||appointment.service_category===item.service_category)
  ).sort((a,b)=>new Date(a.starts_at).getTime()-new Date(b.starts_at).getTime());
}

export function deferredPrimaryAction(status:DeferredServiceItem['status']){
  if(status==='open'||status==='reminded')return 'remind' as const;
  if(status==='booked')return 'complete' as const;
  if(status==='dismissed')return 'reopen' as const;
  return null;
}
