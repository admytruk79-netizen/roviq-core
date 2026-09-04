-- ROVIQ Core migration 014
-- Unified case lifecycle support: vehicles, case events, serviceability constraints,
-- parts readiness, exception enrichment, communications, partner admin, and case financial ledger.
-- Compatibility note: migrations/004_service_orchestration.sql already owns case_exceptions.
-- This migration evolves that table in place and deliberately retains its established
-- case_id / exception_code / state / summary / metadata contract so existing routes,
-- orchestration, analytics and tests remain valid on both fresh and upgraded databases.
begin;

create table if not exists customer_vehicles (
  id uuid primary key default gen_random_uuid(), customer_actor_id uuid, vin text,
  year integer, make text, model text, trim text, nickname text,
  preferences jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists idx_customer_vehicles_vin on customer_vehicles(vin) where vin is not null;

create table if not exists service_case_events (
  id uuid primary key default gen_random_uuid(), service_case_id uuid not null references service_cases(id) on delete cascade,
  event_type text not null, from_state text, to_state text, actor_id uuid, actor_role text,
  source text not null default 'core', correlation_id text, idempotency_key text,
  payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists idx_case_events_case_time on service_case_events(service_case_id, created_at);
create unique index if not exists idx_case_events_idempotency on service_case_events(service_case_id,idempotency_key) where idempotency_key is not null;

create table if not exists case_constraints (
  id uuid primary key default gen_random_uuid(), service_case_id uuid not null references service_cases(id) on delete cascade,
  constraint_type text not null check (constraint_type in ('customer_time','resource','capability','parts','mobility','approval','other')),
  status text not null default 'required' check (status in ('required','satisfied','waived','blocked','unknown')),
  details jsonb not null default '{}'::jsonb, source_connection_id uuid references partner_system_connections(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_case_constraints_case on case_constraints(service_case_id,status);

create table if not exists case_parts_requirements (
  id uuid primary key default gen_random_uuid(), service_case_id uuid not null references service_cases(id) on delete cascade,
  part_reference text, description text, quantity numeric not null default 1,
  readiness_status text not null default 'identified' check (readiness_status in ('identified','sourcing','ordered','eta_known','received','ready','unavailable','cancelled')),
  eta timestamptz, supplier_reference text, external_reference text, updated_at timestamptz not null default now()
);
create index if not exists idx_case_parts_case on case_parts_requirements(service_case_id,readiness_status);

-- case_exceptions is created by migration 004. Preserve the original public/storage contract
-- and add only the fields needed by the vNext exception engine.
alter table case_exceptions add column if not exists owner_actor_id uuid references actors(id);
alter table case_exceptions add column if not exists resource_id uuid references service_resources(id) on delete set null;
alter table case_exceptions add column if not exists connection_id uuid references partner_system_connections(id) on delete set null;
alter table case_exceptions add column if not exists due_at timestamptz;
alter table case_exceptions add column if not exists resolution_code text;
alter table case_exceptions add column if not exists remediation_history jsonb not null default '[]'::jsonb;

-- Existing migration 004 already creates case_exceptions_open_idx on (state,severity,created_at).
-- Keep a case lookup index using the established case_id column.
create index if not exists idx_case_exceptions_case on case_exceptions(case_id);
create index if not exists idx_case_exceptions_due on case_exceptions(state,due_at) where state <> 'resolved';

create table if not exists communication_events (
  id uuid primary key default gen_random_uuid(), service_case_id uuid references service_cases(id) on delete cascade,
  case_event_id uuid references service_case_events(id) on delete set null, recipient_actor_id uuid,
  channel text not null check (channel in ('in_app','push','sms','email')),
  template_key text not null, delivery_status text not null default 'queued' check (delivery_status in ('queued','sent','delivered','failed','suppressed')),
  provider_reference text, failure_reason text, created_at timestamptz not null default now(), delivered_at timestamptz
);
create index if not exists idx_communication_case on communication_events(service_case_id,created_at);

create table if not exists partner_operating_profiles (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade, onboarding_status text not null default 'invited',
  service_capabilities jsonb not null default '[]'::jsonb, territories jsonb not null default '[]'::jsonb,
  credential_status jsonb not null default '{}'::jsonb, commercial_rules jsonb not null default '{}'::jsonb,
  integration_mode text check (integration_mode in ('native_integration','roviq_native','bridge')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists idx_partner_profiles_org_location on partner_operating_profiles(organization_id,location_id);

create table if not exists case_financial_entries (
  id uuid primary key default gen_random_uuid(), service_case_id uuid not null references service_cases(id) on delete cascade,
  entry_type text not null check (entry_type in ('customer_charge','provider_payout','roviq_revenue','processing_cost','refund','cancellation','adjustment','support_cost')),
  amount_cents bigint not null, currency text not null default 'USD', status text not null default 'pending',
  counterparty_actor_id uuid, external_reference text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_case_financial_case on case_financial_entries(service_case_id,created_at);

commit;
