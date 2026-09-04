-- ROVIQ Core migration 014
-- Unified case lifecycle support without duplicating canonical platform primitives.
-- Existing canonical tables remain authoritative:
--   events               -> case/event history
--   notification_outbox  -> communication delivery workflow
--   ledger_entries       -> financial ledger
--   case_exceptions      -> exception state
-- This migration evolves those contracts and adds only genuinely missing operating layers.
begin;

create table if not exists customer_vehicles (
  id uuid primary key default gen_random_uuid(),
  customer_actor_id uuid references actors(id) on delete set null,
  vin text,
  year integer,
  make text,
  model text,
  trim text,
  nickname text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_customer_vehicles_vin on customer_vehicles(vin) where vin is not null;
create index if not exists idx_customer_vehicles_customer on customer_vehicles(customer_actor_id,updated_at desc);

-- Preserve events as the single canonical event stream. Enrich it instead of creating a
-- parallel service_case_events table.
alter table events add column if not exists actor_role text;
alter table events add column if not exists source text not null default 'core';
alter table events add column if not exists idempotency_key text;
create unique index if not exists idx_events_aggregate_idempotency
  on events(aggregate_type,aggregate_id,idempotency_key)
  where idempotency_key is not null;

create table if not exists case_constraints (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null references service_cases(id) on delete cascade,
  constraint_type text not null check (constraint_type in ('customer_time','resource','capability','parts','mobility','approval','other')),
  status text not null default 'required' check (status in ('required','satisfied','waived','blocked','unknown')),
  details jsonb not null default '{}'::jsonb,
  source_connection_id uuid references partner_system_connections(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_case_constraints_case on case_constraints(service_case_id,status);

create table if not exists case_parts_requirements (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null references service_cases(id) on delete cascade,
  part_reference text,
  description text,
  quantity numeric not null default 1 check(quantity > 0),
  readiness_status text not null default 'identified' check (readiness_status in ('identified','sourcing','ordered','eta_known','received','ready','unavailable','cancelled')),
  eta timestamptz,
  supplier_reference text,
  external_reference text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_case_parts_case on case_parts_requirements(service_case_id,readiness_status);

-- case_exceptions is created by migration 004. Preserve case_id / exception_code / state /
-- summary / metadata so existing routes, orchestration, analytics and tests remain compatible.
alter table case_exceptions add column if not exists owner_actor_id uuid references actors(id);
alter table case_exceptions add column if not exists resource_id uuid references service_resources(id) on delete set null;
alter table case_exceptions add column if not exists connection_id uuid references partner_system_connections(id) on delete set null;
alter table case_exceptions add column if not exists due_at timestamptz;
alter table case_exceptions add column if not exists resolution_code text;
alter table case_exceptions add column if not exists remediation_history jsonb not null default '[]'::jsonb;
create index if not exists idx_case_exceptions_case on case_exceptions(case_id);
create index if not exists idx_case_exceptions_due on case_exceptions(state,due_at) where state <> 'resolved';

-- notification_outbox from migration 005 remains the single communication delivery record.
-- Add receipt/suppression metadata instead of creating a second communication_events table.
alter table notification_outbox add column if not exists provider_reference text;
alter table notification_outbox add column if not exists delivered_at timestamptz;
alter table notification_outbox add column if not exists suppressed_at timestamptz;
alter table notification_outbox add column if not exists suppression_reason text;
create index if not exists idx_notification_outbox_case_created on notification_outbox(case_id,created_at);

create table if not exists partner_operating_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  onboarding_status text not null default 'invited',
  service_capabilities jsonb not null default '[]'::jsonb,
  territories jsonb not null default '[]'::jsonb,
  credential_status jsonb not null default '{}'::jsonb,
  commercial_rules jsonb not null default '{}'::jsonb,
  integration_mode text check (integration_mode in ('native_integration','roviq_native','bridge')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_partner_profiles_org_location on partner_operating_profiles(organization_id,location_id);

-- ledger_entries from migration 005 remains the single case financial ledger. Do not create a
-- second case_financial_entries table. Add only reporting metadata required by the master build.
alter table ledger_entries add column if not exists recognition_basis text;
alter table ledger_entries add column if not exists cost_category text;
create index if not exists idx_ledger_case_account on ledger_entries(case_id,account_code,occurred_at);

commit;
