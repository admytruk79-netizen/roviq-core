-- Keep appointment recovery anchored to the original terminal appointment.
-- A replacement may fail and be retried, but it must never become a new
-- recovery root; otherwise chained replacements bypass the one-active-
-- replacement invariant on the original missed/cancelled work.

create or replace function enforce_roviq_appointment_recovery_root()
returns trigger
language plpgsql
as $$
declare
  parent_recovery_source uuid;
begin
  if new.recovery_source_appointment_id is null then
    return new;
  end if;

  select recovery_source_appointment_id
    into parent_recovery_source
    from roviq_appointments
   where id = new.recovery_source_appointment_id;

  if not found then
    raise exception 'recovery_source_appointment_not_found' using errcode = '23503';
  end if;

  if parent_recovery_source is not null then
    raise exception 'recovery_source_must_be_root' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists roviq_appointment_recovery_root_guard on roviq_appointments;
create trigger roviq_appointment_recovery_root_guard
before insert or update of recovery_source_appointment_id on roviq_appointments
for each row
when (new.recovery_source_appointment_id is not null)
execute function enforce_roviq_appointment_recovery_root();
