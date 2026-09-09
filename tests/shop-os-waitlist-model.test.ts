import {describe,expect,it} from 'vitest';
import {appointmentEligibleForWaitlist,bookedAppointmentText,canCancelWaitlistEntry,selectedAppointmentStillEligible} from '../partner/src/shop-os-waitlist-model.js';

const resourceId='11111111-1111-4111-8111-111111111111';
const resources=new Map([[resourceId,{id:resourceId,resource_type:'bay'}]]);
const entry={
  service_case_id:'22222222-2222-4222-8222-222222222222',
  requested_service_category:'brakes',
  requested_after:'2026-12-01T10:00:00Z',
  requested_before:'2026-12-01T13:00:00Z',
  estimated_duration_minutes:60,
  preferred_resource_types:['bay']
};
const appointment={
  id:'33333333-3333-4333-8333-333333333333',
  service_case_id:entry.service_case_id,
  appointment_status:'held',
  starts_at:'2026-12-01T10:30:00Z',
  ends_at:'2026-12-01T11:30:00Z',
  service_category:'brakes',
  resource_id:resourceId
};

describe('Shop OS waitlist UI contract',()=>{
  it('shows the canonical booked appointment identifier for booked work',()=>{
    expect(bookedAppointmentText({state:'booked',booked_appointment_id:'11111111-1111-4111-8111-111111111111'}))
      .toBe('Booked · 11111111-1111-4111-8111-111111111111');
  });

  it('only exposes cancellation for backend-supported waitlist states',()=>{
    expect(canCancelWaitlistEntry({state:'waiting'})).toBe(true);
    expect(canCancelWaitlistEntry({state:'offered'})).toBe(true);
    expect(canCancelWaitlistEntry({state:'expired'})).toBe(false);
    expect(canCancelWaitlistEntry({state:'booked'})).toBe(false);
    expect(canCancelWaitlistEntry({state:'cancelled'})).toBe(false);
  });

  it('accepts only appointments satisfying every canonical waitlist constraint',()=>{
    expect(appointmentEligibleForWaitlist(entry,appointment,resources)).toBe(true);
    expect(appointmentEligibleForWaitlist(entry,{...appointment,appointment_status:'cancelled'},resources)).toBe(false);
    expect(appointmentEligibleForWaitlist(entry,{...appointment,service_case_id:null},resources)).toBe(false);
    expect(appointmentEligibleForWaitlist(entry,{...appointment,service_category:null},resources)).toBe(false);
    expect(appointmentEligibleForWaitlist(entry,{...appointment,starts_at:'2026-12-01T09:59:00Z'},resources)).toBe(false);
    expect(appointmentEligibleForWaitlist(entry,{...appointment,ends_at:'2026-12-01T13:01:00Z'},resources)).toBe(false);
    expect(appointmentEligibleForWaitlist(entry,{...appointment,ends_at:'2026-12-01T11:00:00Z'},resources)).toBe(false);
    expect(appointmentEligibleForWaitlist(entry,{...appointment,resource_id:'44444444-4444-4444-8444-444444444444'},resources)).toBe(false);
  });

  it('invalidates a selected appointment when refresh removes it from eligible choices',()=>{
    expect(selectedAppointmentStillEligible(appointment.id,[appointment])).toBe(true);
    expect(selectedAppointmentStillEligible(appointment.id,[])).toBe(false);
  });
});
