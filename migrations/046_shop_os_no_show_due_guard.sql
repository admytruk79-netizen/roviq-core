-- Prevent any write path from storing a customer no-show before the scheduled start.
-- Enforced on both INSERT and UPDATE so direct inserts, status transitions and later
-- starts_at changes cannot move a no-show into the future.

create or replace function enforce_roviq_appointment_no_show_due()
returns trigger
language plpgsql
as $$
begin
  if new.appointment_status = 'no_show'
     and new.starts_at > now() then
    raise exception 'appointment_no_show_before_start' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists roviq_appointment_no_show_due_guard on roviq_appointments;
create trigger roviq_appointment_no_show_due_guard
before insert or update of appointment_status, starts_at on roviq_appointments
for each row
execute function enforce_roviq_appointment_no_show_due();
