-- The vehicle on a Service Case. customer_vehicles is the canonical vehicle record: Shop OS repair
-- orders, deferred service, connected devices and warranties already reference it. Migration 016
-- created service_cases.vehicle_id pointing at the older, never-populated `vehicles` table, and
-- 059's `add column if not exists ... references customer_vehicles` was a no-op because the column
-- already existed -- so linking a customer vehicle to a case violated the foreign key.

-- Carry over any case-linked rows from the legacy table so no link is lost, keeping their ids.
insert into customer_vehicles(id,customer_actor_id,vin,year,make,model,trim,created_at,updated_at)
select v.id,v.owner_actor_id,upper(v.vin),v.year,v.make,v.model,v.trim,v.created_at,v.updated_at
  from vehicles v
 where exists(select 1 from service_cases sc where sc.vehicle_id=v.id)
   and not exists(select 1 from customer_vehicles cv where cv.id=v.id)
on conflict do nothing;
update service_cases sc set vehicle_id=null
 where vehicle_id is not null and not exists(select 1 from customer_vehicles cv where cv.id=sc.vehicle_id);

alter table service_cases drop constraint if exists service_cases_vehicle_id_fkey;
alter table service_cases
  add constraint service_cases_vehicle_id_fkey foreign key (vehicle_id) references customer_vehicles(id) on delete set null;

-- What the network needs to find, move, diagnose and part the vehicle.
alter table customer_vehicles
  add column if not exists color text,
  add column if not exists license_plate text,
  add column if not exists plate_region text,
  add column if not exists drivetrain text check (drivetrain is null or drivetrain in ('fwd','rwd','awd','4wd')),
  add column if not exists engine text,
  add column if not exists fuel_type text check (fuel_type is null or fuel_type in ('gasoline','diesel','hybrid','plug_in_hybrid','electric','other')),
  add column if not exists odometer_value integer check (odometer_value is null or odometer_value >= 0),
  add column if not exists odometer_unit text not null default 'miles' check (odometer_unit in ('miles','kilometers')),
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by_actor_id uuid references actors(id) on delete set null,
  add column if not exists archived_at timestamptz;

-- VINs are case-insensitive; store them uppercase so the unique index means one vehicle per VIN.
update customer_vehicles c set vin=upper(c.vin)
 where c.vin is not null and c.vin<>upper(c.vin)
   and not exists(select 1 from customer_vehicles o where o.id<>c.id and upper(o.vin)=upper(c.vin));
