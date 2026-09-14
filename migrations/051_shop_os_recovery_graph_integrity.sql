-- Close recovery-graph holes left by the original root guard.
-- Recovery must remain a one-level star anchored on the original terminal
-- appointment: roots may have replacement children, but children may not
-- themselves become parents and a root with children may not be reparented.

create or replace function enforce_roviq_appointment_recovery_root()
returns trigger
language plpgsql
as $$
declare
  parent_recovery_source uuid;
  existing_child uuid;
begin
  if new.recovery_source_appointment_id is null then
    return new;
  end if;

  if new.recovery_source_appointment_id = new.id then
    raise exception 'recovery_source_cannot_reference_self' using errcode = 'P0001';
  end if;

  -- Lock the chosen parent. This serializes a child insertion against a
  -- concurrent attempt to reparent the same root: whichever transaction wins,
  -- the loser re-evaluates against the committed graph and fails closed.
  select recovery_source_appointment_id
    into parent_recovery_source
    from roviq_appointments
   where id = new.recovery_source_appointment_id
   for update;

  if not found then
    raise exception 'recovery_source_appointment_not_found' using errcode = '23503';
  end if;

  if parent_recovery_source is not null then
    raise exception 'recovery_source_must_be_root' using errcode = 'P0001';
  end if;

  -- An existing root that already anchors one or more recovery appointments
  -- cannot itself be turned into a child, which would create a recovery chain.
  if tg_op = 'UPDATE' and old.recovery_source_appointment_id is null then
    select id
      into existing_child
      from roviq_appointments
     where recovery_source_appointment_id = new.id
       and id <> new.id
     order by id
     limit 1
     for update;

    if found then
      raise exception 'recovery_root_has_children' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

-- Preserve the existing trigger name so upgrades replace behavior in place.
drop trigger if exists roviq_appointment_recovery_root_guard on roviq_appointments;
create trigger roviq_appointment_recovery_root_guard
before insert or update of recovery_source_appointment_id on roviq_appointments
for each row
when (new.recovery_source_appointment_id is not null)
execute function enforce_roviq_appointment_recovery_root();

-- Enforce the simplest graph invariant at table level as a second line of
-- defense. NOT VALID avoids making deployment dependent on historical rows;
-- all new/updated rows are still checked immediately.
alter table roviq_appointments
  drop constraint if exists roviq_appointments_recovery_not_self;
alter table roviq_appointments
  add constraint roviq_appointments_recovery_not_self
  check (recovery_source_appointment_id is null or recovery_source_appointment_id <> id)
  not valid;
