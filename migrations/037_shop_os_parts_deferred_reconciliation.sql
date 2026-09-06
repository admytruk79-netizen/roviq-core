-- ROVIQ Core migration 037
-- Complete Shop OS service-day continuity with parts readiness, deferred work CRM,
-- and repair-order reconciliation against the canonical ledger.

begin;

alter table case_parts_requirements
  add column if not exists repair_order_id uuid references shop_repair_orders(id) on delete set null,
  add column if not exists repair_order_line_id uuid references shop_repair_order_lines(id) on delete set null,
  add column if not exists parts_order_id uuid references parts_orders(id) on delete set null;

create index if not exists idx_case_parts_repair_order
  on case_parts_requirements(repair_order_id,readiness_status,updated_at desc)
  where repair_order_id is not null;
create unique index if not exists idx_case_parts_repair_line_unique
  on case_parts_requirements(repair_order_line_id)
  where repair_order_line_id is not null and readiness_status <> 'cancelled';

create table if not exists shop_deferred_service_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  service_case_id uuid references service_cases(id) on delete set null,
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  repair_order_line_id uuid not null references shop_repair_order_lines(id) on delete cascade,
  customer_vehicle_id uuid references customer_vehicles(id) on delete set null,
  status text not null default 'open' check (status in ('open','reminded','booked','completed','dismissed')),
  severity text not null default 'recommended' check (severity in ('recommended','attention','urgent')),
  reason text,
  estimated_amount numeric(12,2) not null default 0 check (estimated_amount >= 0),
  target_return_at timestamptz,
  next_follow_up_at timestamptz,
  follow_up_count integer not null default 0 check (follow_up_count >= 0),
  booked_appointment_id uuid references roviq_appointments(id) on delete set null,
  created_by_actor_id uuid references actors(id) on delete set null,
  completed_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(repair_order_line_id)
);
create index if not exists idx_shop_deferred_followup
  on shop_deferred_service_items(organization_id,location_id,status,next_follow_up_at,updated_at desc);
create index if not exists idx_shop_deferred_vehicle
  on shop_deferred_service_items(customer_vehicle_id,status,updated_at desc)
  where customer_vehicle_id is not null;

alter table ledger_entries
  add column if not exists repair_order_id uuid references shop_repair_orders(id) on delete set null,
  add column if not exists reconciliation_key text;
create unique index if not exists idx_ledger_repair_order_reconciliation
  on ledger_entries(repair_order_id,reconciliation_key)
  where repair_order_id is not null and reconciliation_key is not null;
create index if not exists idx_ledger_repair_order
  on ledger_entries(repair_order_id,occurred_at desc)
  where repair_order_id is not null;

commit;
