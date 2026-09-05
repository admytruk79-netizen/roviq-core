-- ROVIQ Core migration 030
-- Native Shop OS appointment lifecycle, resource conflict protection, and capacity baselines.

begin;

create extension if not exists btree_gist;

alter table roviq_appointments
  add column if not exists lifecycle_version integer not null default 1,
  add column if not exists released_reason text;

alter table capacity_windows
  add column if not exists nominal_capacity_units integer;

update capacity_windows
set nominal_capacity_units=capacity_units
where nominal_capacity_units is null;

alter table capacity_windows
  alter column nominal_capacity_units set default 1;

alter table capacity_windows
  alter column nominal_capacity_units set not null;

alter table capacity_windows
  drop constraint if exists capacity_windows_nominal_capacity_units_check;
alter table capacity_windows
  add constraint capacity_windows_nominal_capacity_units_check
  check (nominal_capacity_units >= 0);

alter table roviq_appointments
  drop constraint if exists roviq_appointments_resource_schedule_excl;
alter table roviq_appointments
  add constraint roviq_appointments_resource_schedule_excl
  exclude using gist (
    resource_id with =,
    tstzrange(starts_at,ends_at,'[)') with &&
  )
  where (
    resource_id is not null
    and appointment_status in ('held','confirmed','in_progress')
  );

create index if not exists idx_roviq_appointments_resource_active
  on roviq_appointments(resource_id,starts_at,ends_at)
  where appointment_status in ('held','confirmed','in_progress');

commit;
