-- ROVIQ Core migration 034
-- Shop OS fixed-operations foundation: operational resources and repair orders.
-- Keeps Service Case, events, capacity, parts, notifications and ledger primitives canonical.

begin;

-- Expand native resource vocabulary for shop-floor equipment while preserving
-- the canonical service_resources table used by capacity and scheduling.
alter table service_resources drop constraint if exists service_resources_resource_type_check;
alter table service_resources add constraint service_resources_resource_type_check
  check (resource_type in ('bay','technician','advisor','equipment','mobile_unit','tow_unit','valet_driver','loaner_vehicle'));

alter table service_resources
  add column if not exists operational_state text not null default 'available',
  add column if not exists assigned_actor_id uuid references actors(id) on delete set null,
  add column if not exists hourly_cost numeric(12,2),
  add column if not exists labor_rate numeric(12,2);

alter table service_resources drop constraint if exists service_resources_operational_state_check;
alter table service_resources add constraint service_resources_operational_state_check
  check (operational_state in ('available','busy','blocked','offline'));

alter table service_resources drop constraint if exists service_resources_hourly_cost_check;
alter table service_resources add constraint service_resources_hourly_cost_check
  check (hourly_cost is null or hourly_cost >= 0);
alter table service_resources drop constraint if exists service_resources_labor_rate_check;
alter table service_resources add constraint service_resources_labor_rate_check
  check (labor_rate is null or labor_rate >= 0);

create index if not exists idx_service_resources_shop_ops
  on service_resources(organization_id,location_id,resource_type,active,operational_state);
create index if not exists idx_service_resources_assigned_actor
  on service_resources(assigned_actor_id) where assigned_actor_id is not null;

create table if not exists shop_repair_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  service_case_id uuid references service_cases(id) on delete set null,
  appointment_id uuid references roviq_appointments(id) on delete set null,
  customer_vehicle_id uuid references customer_vehicles(id) on delete set null,
  advisor_actor_id uuid references actors(id) on delete set null,
  primary_technician_actor_id uuid references actors(id) on delete set null,
  repair_order_number text not null,
  status text not null default 'draft' check (status in (
    'draft','estimate_pending','awaiting_approval','approved','in_progress',
    'waiting_parts','waiting_customer','quality_control','completed','closed','cancelled'
  )),
  customer_concern text,
  internal_notes text,
  odometer integer check (odometer is null or odometer >= 0),
  estimate_version integer not null default 1 check (estimate_version > 0),
  subtotal_amount numeric(12,2) not null default 0 check (subtotal_amount >= 0),
  tax_amount numeric(12,2) not null default 0 check (tax_amount >= 0),
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  approved_amount numeric(12,2) not null default 0 check (approved_amount >= 0),
  created_by_actor_id uuid references actors(id) on delete set null,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,repair_order_number)
);

create index if not exists idx_shop_repair_orders_case on shop_repair_orders(service_case_id);
create index if not exists idx_shop_repair_orders_appointment on shop_repair_orders(appointment_id);
create index if not exists idx_shop_repair_orders_shop_status
  on shop_repair_orders(organization_id,location_id,status,updated_at desc);

create table if not exists shop_repair_order_lines (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  line_type text not null check (line_type in ('labor','part','fee','sublet')),
  description text not null,
  service_category text,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  labor_hours numeric(8,2) check (labor_hours is null or labor_hours >= 0),
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','declined','deferred')),
  taxable boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  declined_at timestamptz,
  deferred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shop_repair_order_lines_order
  on shop_repair_order_lines(repair_order_id,sort_order,id);
create index if not exists idx_shop_repair_order_lines_approval
  on shop_repair_order_lines(repair_order_id,approval_status);

commit;
