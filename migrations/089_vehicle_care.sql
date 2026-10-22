-- Record changes atomically with the canonical vehicle, including writes from shop intake.
-- These are reported readings/revisions, not a certified odometer or inferred driving distance.
create table vehicle_odometer_history (
  id bigserial primary key,
  vehicle_id uuid not null references customer_vehicles(id),
  value integer not null check(value >= 0),
  unit text not null check(unit in ('miles','kilometers')),
  source text not null check(source in ('baseline','reported','on_site_confirmation')),
  recorded_at timestamptz not null default now()
);
create index vehicle_odometer_history_vehicle_idx on vehicle_odometer_history(vehicle_id,id desc);
insert into vehicle_odometer_history(vehicle_id,value,unit,source)
select id,odometer_value,odometer_unit,'baseline' from customer_vehicles where odometer_value is not null;

create function record_vehicle_odometer() returns trigger language plpgsql as $$
begin
  if new.odometer_value is not null then
    if TG_OP = 'INSERT' then
      insert into vehicle_odometer_history(vehicle_id,value,unit,source)
      values(new.id,new.odometer_value,new.odometer_unit,'reported');
    elsif new.odometer_value is distinct from old.odometer_value or new.odometer_unit is distinct from old.odometer_unit then
      insert into vehicle_odometer_history(vehicle_id,value,unit,source)
      values(new.id,new.odometer_value,new.odometer_unit,
        case when new.verified_at is distinct from old.verified_at and new.verified_at is not null
          then 'on_site_confirmation' else 'reported' end);
    end if;
  end if;
  return new;
end $$;
create trigger vehicle_odometer_record after insert or update on customer_vehicles
for each row execute function record_vehicle_odometer();

create table vehicle_service_reminders (
  id uuid primary key,
  vehicle_id uuid not null references customer_vehicles(id),
  title text not null check(length(title) between 1 and 120),
  due_date date,
  due_odometer integer check(due_odometer between 0 and 2000000),
  odometer_unit text not null check(odometer_unit in ('miles','kilometers')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check(due_date is not null or due_odometer is not null)
);
create index vehicle_service_reminders_vehicle_idx on vehicle_service_reminders(vehicle_id,created_at desc);
