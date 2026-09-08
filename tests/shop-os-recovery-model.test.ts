import {describe,expect,it} from 'vitest';
import {defaultRecoveryWindow,isRecoverableAppointment,replacementAppointmentBody} from '../partner/src/shop-os-recovery-model.js';

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
  it('treats only unrecovered cancelled and no-show appointments as actionable',()=>{
    expect(isRecoverableAppointment(base)).toBe(true);
    expect(isRecoverableAppointment({...base,appointment_status:'no_show'})).toBe(true);
    expect(isRecoverableAppointment({...base,appointment_status:'held'})).toBe(false);
    expect(isRecoverableAppointment({...base,appointment_status:'completed'})).toBe(false);
    expect(isRecoverableAppointment({...base,active_replacement_appointment_id:'55555555-5555-4555-8555-555555555555'})).toBe(false);
  });

  it('moves an elapsed appointment to the next future half-hour slot while preserving duration',()=>{
    const window=defaultRecoveryWindow(base,new Date('2026-09-08T18:05:00.000Z').getTime());
    expect(window).toEqual({startsAt:'2026-09-08T19:00:00.000Z',endsAt:'2026-09-08T20:00:00.000Z'});
  });

  it('keeps an already-future original slot when it remains safely ahead of now',()=>{
    const window=defaultRecoveryWindow(base,new Date('2026-09-08T14:00:00.000Z').getTime());
    expect(window).toEqual({startsAt:base.starts_at,endsAt:base.ends_at});
  });

  it('creates a new held booking payload linked to its terminal source',()=>{
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
      internalNotes:`Replacement appointment for cancelled appointment ${base.id}`,
      recoverySourceAppointmentId:base.id
    });
    expect(base.appointment_status).toBe('cancelled');
  });
});