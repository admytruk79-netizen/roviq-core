-- Persist the source-to-replacement relationship for cancelled/no-show recovery.
-- Only one satisfying replacement may exist for a source appointment at a time.
-- Cancelled/no-show/released replacements permit a retry; completed replacements permanently satisfy recovery.

alter table roviq_appointments
  add column if not exists recovery_source_appointment_id uuid null references roviq_appointments(id);

create index if not exists roviq_appointments_recovery_source_idx
  on roviq_appointments(recovery_source_appointment_id)
  where recovery_source_appointment_id is not null;

drop index if exists roviq_appointments_one_active_recovery_idx;
create unique index roviq_appointments_one_active_recovery_idx
  on roviq_appointments(recovery_source_appointment_id)
  where recovery_source_appointment_id is not null
    and appointment_status in ('held','confirmed','in_progress','completed');
