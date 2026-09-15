import { httpError } from './shop-os-scheduling-rules.js';

export function rethrowSchedulingError(error:unknown):never{
  const dbError=error as {code?:string;constraint?:string};
  const code=dbError?.code;
  const message=error instanceof Error?error.message:'';

  if(code==='23P01') throw httpError('resource_schedule_conflict',409);
  if(code==='40P01'||code==='55P03') throw httpError('scheduling_conflict',409);

  if(code==='23503'&&message.includes('recovery_source_appointment_not_found')){
    throw httpError('recovery_source_appointment_not_found',404);
  }

  if(code==='P0001'){
    if(message.includes('shop_os_recovery_source_not_root')||message.includes('recovery_source_must_be_root')){
      throw httpError('shop_os_recovery_source_not_root',409);
    }
    if(message.includes('recovery_source_cannot_reference_self')){
      throw httpError('recovery_source_cannot_reference_self',409);
    }
    if(message.includes('recovery_root_has_children')){
      throw httpError('recovery_root_has_children',409);
    }
  }

  if(code==='23505'&&dbError.constraint==='roviq_appointments_one_active_recovery_idx'){
    throw httpError('appointment_recovery_already_exists',409);
  }

  if(error instanceof Error&&['appointment_transition_invalid','appointment_not_reschedulable'].includes(error.message)){
    throw httpError(error.message,409);
  }

  throw error;
}
