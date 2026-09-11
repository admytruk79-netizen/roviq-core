import { httpError } from './shop-os-scheduling-rules.js';

export function rethrowSchedulingError(error:unknown):never{
  const code=(error as {code?:string})?.code;
  if(code==='23P01') throw httpError('resource_schedule_conflict',409);
  if(code==='P0001'&&error instanceof Error&&error.message.includes('shop_os_recovery_source_not_root')){
    throw httpError('shop_os_recovery_source_not_root',409);
  }
  if((error as {code?:string,constraint?:string})?.code==='23505'&&(error as {constraint?:string}).constraint==='roviq_appointments_one_active_recovery_idx'){
    throw httpError('appointment_recovery_already_exists',409);
  }
  if(error instanceof Error&&['appointment_transition_invalid','appointment_not_reschedulable'].includes(error.message)){
    throw httpError(error.message,409);
  }
  throw error;
}
