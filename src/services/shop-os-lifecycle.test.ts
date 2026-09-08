import { describe,expect,it } from 'vitest';
import { nextShopOsAppointmentStatus } from './shop-os-lifecycle.js';

describe('Shop OS appointment lifecycle',()=>{
  it('moves a held appointment through confirm, start and complete',()=>{
    const confirmed=nextShopOsAppointmentStatus('held','confirm');
    const inProgress=nextShopOsAppointmentStatus(confirmed,'start');
    expect(nextShopOsAppointmentStatus(inProgress,'complete')).toBe('completed');
  });

  it('keeps held and confirmed appointments in the same state when rescheduled',()=>{
    expect(nextShopOsAppointmentStatus('held','reschedule')).toBe('held');
    expect(nextShopOsAppointmentStatus('confirmed','reschedule')).toBe('confirmed');
  });

  it('allows explicit release before work starts',()=>{
    expect(nextShopOsAppointmentStatus('held','release')).toBe('released');
    expect(nextShopOsAppointmentStatus('confirmed','release')).toBe('released');
  });

  it('prevents terminal appointments from being rescheduled or restarted',()=>{
    expect(()=>nextShopOsAppointmentStatus('completed','reschedule')).toThrow('appointment_not_reschedulable');
    expect(()=>nextShopOsAppointmentStatus('completed','start')).toThrow('appointment_transition_invalid');
    expect(()=>nextShopOsAppointmentStatus('cancelled','confirm')).toThrow('appointment_transition_invalid');
  });
});
