-- Shop-owned records for direct work; separate from platform customer actors.
create table shop_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  location_id uuid references locations(id),
  display_name text not null check (length(trim(display_name)) between 1 and 200),
  email text,
  phone text,
  created_by_actor_id uuid references actors(id),
  created_at timestamptz not null default now(),
  unique(id,organization_id)
);
create index shop_customers_scope_idx on shop_customers(organization_id,location_id,display_name);
create table shop_vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  shop_customer_id uuid not null,
  make text not null check(length(trim(make)) between 1 and 100),
  model text not null check(length(trim(model)) between 1 and 100),
  model_year integer check(model_year between 1886 and 2200),
  vin text check(vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  license_plate text,
  created_at timestamptz not null default now(),
  foreign key(shop_customer_id,organization_id) references shop_customers(id,organization_id),
  unique(id,shop_customer_id,organization_id)
);
create index shop_vehicles_customer_idx on shop_vehicles(organization_id,shop_customer_id);

alter table shop_repair_orders add column shop_customer_id uuid, add column shop_vehicle_id uuid;
alter table shop_repair_orders add constraint shop_ro_customer_fk foreign key(shop_customer_id,organization_id) references shop_customers(id,organization_id);
alter table shop_repair_orders add constraint shop_ro_vehicle_fk foreign key(shop_vehicle_id,shop_customer_id,organization_id) references shop_vehicles(id,shop_customer_id,organization_id);
alter table shop_repair_orders add constraint shop_ro_local_vehicle_customer check(shop_vehicle_id is null or shop_customer_id is not null);
alter table shop_repair_orders add constraint shop_ro_local_context check(shop_customer_id is null or (service_case_id is null and customer_vehicle_id is null));
create index shop_ro_local_history_idx on shop_repair_orders(organization_id,shop_customer_id,shop_vehicle_id);

alter table roviq_appointments add column shop_customer_id uuid, add column shop_vehicle_id uuid;
alter table roviq_appointments add constraint shop_appointment_customer_fk foreign key(shop_customer_id,organization_id) references shop_customers(id,organization_id);
alter table roviq_appointments add constraint shop_appointment_vehicle_fk foreign key(shop_vehicle_id,shop_customer_id,organization_id) references shop_vehicles(id,shop_customer_id,organization_id);
alter table roviq_appointments add constraint shop_appointment_local_vehicle_customer check(shop_vehicle_id is null or shop_customer_id is not null);
alter table roviq_appointments add constraint shop_appointment_local_context check(shop_customer_id is null or service_case_id is null);
