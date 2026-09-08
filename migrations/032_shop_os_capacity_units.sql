-- ROVIQ Core migration 032
-- Allow a native Shop OS resource to carry more than one concurrent appointment
-- when its canonical capacity window exposes more than one nominal capacity unit.
--
-- Migration 030 used a GiST exclusion constraint to prevent every overlapping
-- appointment on a resource. That was safe for one-unit resources, but it made
-- nominal_capacity_units > 1 impossible to use. Shop OS scheduling now serializes
-- writes by locking the service_resource row and checks overlapping active
-- appointments plus held case reservations against the locked canonical capacity
-- window before insert/update. That transaction is the authoritative concurrency
-- guard for multi-unit resources.

begin;

alter table roviq_appointments
  drop constraint if exists roviq_appointments_resource_schedule_excl;

-- Keep the overlap lookup efficient for the transactional capacity check.
create index if not exists idx_roviq_appointments_resource_active
  on roviq_appointments(resource_id,starts_at,ends_at)
  where appointment_status in ('held','confirmed','in_progress');

commit;
