import {describe,expect,it} from 'vitest';
import {isRecoverableAppointment,replacementAppointmentBody} from '../partner/src/shop-os-recovery-model.js';

const base={
  id:'11111111-1111-4111-8111-111111111111',
  resource_id:'22222222-2222-4222-8222-222222222222',
  service_case_id:'33333333-3333-4333-8333-333333333333',
  appointment_status:'cancelled',
  starts_at:'2026-09-08T16:00:00.000Z',
  ends_at:'2026-09-08T17:00:00.000Z',
  service_category:'maintenance',
  customer_visible_summary:'Brake service'
};

describe('Shop OS cancelled/no-show recovery model',()=>{
  it('treats only cancelled and no-show appointments as recoverable terminal history',()=>{
    expect(isRecoverableAppointment(base)).toBe(true);
    expect(isRecoverableAppointment({...base,appointment_status:'no_show'})).toBe(true);
    expect(isRecoverableAppointment({...base,appointment_status:'held'})).toBe(false);
    expect(isRecoverableAppointment({...base,appointment_status:'completed'})).toBe(false);
  });

  it('creates a new held booking payload without mutating the terminal appointment',()=>{
    const body=replacementAppointmentBody(
      base,
      '44444444-4444-4444-8444-444444444444',
      '2026-09-09T18:00:00.000Z',
      '2026-09-09T19:00:00.000Z'
    );
    expect(body).toEqual({
      serviceCaseId:base.service_case_id,
      resourceId:'44444444-4444-4444-8444-444444444444',
      startsAt:'2026-09-09T18:00:00.000Z',
      endsAt:'2026-09-09T19:00:00.000Z',
      serviceCategory:'maintenance',
      status:'held',
      customerVisibleSummary:'Brake service',
      internalNotes:`Replacement appointment for cancelled appointment ${base.id}`
    });
    expect(base.appointment_status).toBe('cancelled');
  });
});
