import {describe,expect,it} from 'vitest';
import {bookedAppointmentText,canCancelWaitlistEntry} from '../partner/src/shop-os-waitlist-model.js';

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
});
