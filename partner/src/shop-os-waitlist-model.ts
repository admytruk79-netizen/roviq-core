export type ShopWaitlistState='waiting'|'offered'|'booked'|'expired'|'cancelled';

export type ShopWaitlistEntryModel={
  state:ShopWaitlistState;
  booked_appointment_id?:string|null;
};

export function canCancelWaitlistEntry(entry:ShopWaitlistEntryModel){
  return entry.state==='waiting'||entry.state==='offered';
}

export function bookedAppointmentText(entry:ShopWaitlistEntryModel){
  if(entry.state!=='booked') return null;
  return entry.booked_appointment_id?`Booked · ${entry.booked_appointment_id}`:'Booked';
}
