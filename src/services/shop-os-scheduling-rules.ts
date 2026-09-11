import type { PoolClient } from 'pg';

export type Queryable=Pick<PoolClient,'query'>;
export type ShopOsAppointmentStatus='held'|'confirmed'|'in_progress'|'completed'|'cancelled'|'no_show'|'released';
export type ShopOsAppointmentAction='confirm'|'start'|'complete'|'cancel'|'release'|'no_show'|'reschedule';

const transitionMap:Record<Exclude<ShopOsAppointmentAction,'reschedule'>,Record<string,ShopOsAppointmentStatus>>={
  confirm:{held:'confirmed'},
  start:{confirmed:'in_progress'},
  complete:{in_progress:'completed'},
  cancel:{held:'cancelled',confirmed:'cancelled',in_progress:'cancelled'},
  release:{held:'released',confirmed:'released'},
  no_show:{held:'no_show',confirmed:'no_show'}
};

export function httpError(message:string,statusCode:number){
  const error=new Error(message) as Error&{statusCode:number};
  error.statusCode=statusCode;
  return error;
}

export function nextShopOsAppointmentStatus(current:ShopOsAppointmentStatus,action:ShopOsAppointmentAction):ShopOsAppointmentStatus{
  if(action==='reschedule'){
    if(!['held','confirmed'].includes(current)) throw new Error('appointment_not_reschedulable');
    return current;
  }
  const next=transitionMap[action][current];
  if(!next) throw new Error('appointment_transition_invalid');
  return next;
}

export function assertAppointmentInterval(startsAt:string|Date,endsAt:string|Date){
  const startMs=new Date(startsAt).getTime();
  const endMs=new Date(endsAt).getTime();
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs) throw httpError('appointment_interval_invalid',400);
}
