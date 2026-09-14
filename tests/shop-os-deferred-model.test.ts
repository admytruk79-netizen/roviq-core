import {describe,expect,it} from 'vitest';
import {deferredPrimaryAction,eligibleDeferredAppointments} from '../partner/src/shop-os-deferred-model.js';

const item={
  id:'11111111-1111-4111-8111-111111111111',
  status:'open' as const,
  service_case_id:'22222222-2222-4222-8222-222222222222',
  service_category:'maintenance'
};

const appointments=[
  {id:'a',service_case_id:item.service_case_id,appointment_status:'held',starts_at:'2026-09-10T18:00:00Z',ends_at:'2026-09-10T19:00:00Z',service_category:'maintenance'},
  {id:'b',service_case_id:item.service_case_id,appointment_status:'confirmed',starts_at:'2026-09-09T18:00:00Z',ends_at:'2026-09-09T19:00:00Z',service_category:null},
  {id:'c',service_case_id:item.service_case_id,appointment_status:'completed',starts_at:'2026-09-08T18:00:00Z',ends_at:'2026-09-08T19:00:00Z',service_category:'maintenance'},
  {id:'d',service_case_id:'33333333-3333-4333-8333-333333333333',appointment_status:'held',starts_at:'2026-09-09T17:00:00Z',ends_at:'2026-09-09T18:00:00Z',service_category:'maintenance'},
  {id:'e',service_case_id:item.service_case_id,appointment_status:'held',starts_at:'2026-09-09T16:00:00Z',ends_at:'2026-09-09T17:00:00Z',service_category:'diagnostic'}
];

describe('Shop OS deferred service model',()=>{
  it('offers only active appointments for the same case and compatible service category',()=>{
    expect(eligibleDeferredAppointments(item,appointments).map(a=>a.id)).toEqual(['b','a']);
  });

  it('keeps primary follow-up actions aligned with backend transitions',()=>{
    expect(deferredPrimaryAction('open')).toBe('remind');
    expect(deferredPrimaryAction('reminded')).toBe('remind');
    expect(deferredPrimaryAction('booked')).toBe('complete');
    expect(deferredPrimaryAction('dismissed')).toBe('reopen');
    expect(deferredPrimaryAction('completed')).toBeNull();
  });
});
