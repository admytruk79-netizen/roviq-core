-- ROVIQ Core migration 059
-- Connected vehicle ingestion + warranty-aware coordination foundations.
-- This extends the existing canonical Service Case model rather than creating a second Core.

begin;

alter table service_cases
  add column if not exists vehicle_id uuid references customer_vehicles(id) on delete set null;
create index if not exists idx_service_cases_vehicle on service_cases(vehicle_id, updated_at desc);

create table if not exists connected_sources (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('roviq_reader','oem_telematics','vehicle_api','customer_reported','technician','integration')),
  provider_key text not null,
  organization_id uuid references organizations(id) on delete set null,
  status text not null default 'active' check (status in ('active','paused','degraded','revoked')),
  capability_profile jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_connected_sources_type_status on connected_sources(source_type,status);

create table if not exists connected_vehicle_consents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references customer_vehicles(id) on delete cascade,
  customer_actor_id uuid not null references actors(id) on delete cascade,
  consent_type text not null default 'vehicle_health',
  consent_version text not null,
  status text not null default 'active' check (status in ('active','revoked','expired')),
  scopes jsonb not null default '[]'::jsonb,
  retention_until timestamptz,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_connected_consents_vehicle on connected_vehicle_consents(vehicle_id,status,granted_at desc);

create table if not exists device_enrollments (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references customer_vehicles(id) on delete cascade,
  source_id uuid not null references connected_sources(id) on delete restrict,
  consent_id uuid not null references connected_vehicle_consents(id) on delete restrict,
  external_device_id text,
  enrollment_status text not null default 'active' check (enrollment_status in ('active','paused','revoked')),
  enrolled_at timestamptz not null default now(),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id, external_device_id)
);
create index if not exists idx_device_enrollments_vehicle on device_enrollments(vehicle_id,enrollment_status);

create table if not exists vehicle_capability_profiles (
  vehicle_id uuid primary key references customer_vehicles(id) on delete cascade,
  supported_pids jsonb not null default '[]'::jsonb,
  supported_protocols jsonb not null default '[]'::jsonb,
  manufacturer_specific_access boolean not null default false,
  capability_source text,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists vehicle_health_events (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references customer_vehicles(id) on delete cascade,
  source_id uuid not null references connected_sources(id) on delete restrict,
  enrollment_id uuid references device_enrollments(id) on delete set null,
  service_case_id uuid references service_cases(id) on delete set null,
  source_event_id text,
  event_type text not null,
  severity text not null default 'advisory' check (severity in ('info','advisory','warning','critical')),
  safety_state text not null default 'review_required' check (safety_state in ('unknown','review_required','restricted_use','stop_driving')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  dtc_codes text[] not null default '{}',
  normalized_signals jsonb not null default '{}'::jsonb,
  raw_reference jsonb not null default '{}'::jsonb,
  deduplication_key text not null,
  triage_state text not null default 'unreviewed' check (triage_state in ('unreviewed','customer_confirmation_required','triaged','linked_to_case','ignored')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(source_id,deduplication_key)
);
create index if not exists idx_vehicle_health_vehicle_time on vehicle_health_events(vehicle_id,occurred_at desc);
create index if not exists idx_vehicle_health_case on vehicle_health_events(service_case_id) where service_case_id is not null;
create index if not exists idx_vehicle_health_triage on vehicle_health_events(triage_state,severity,received_at);

create table if not exists warranty_coverages (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references customer_vehicles(id) on delete cascade,
  coverage_type text not null check (coverage_type in ('factory','extended','service_contract','none','unknown')),
  coverage_status text not null default 'unknown' check (coverage_status in ('unknown','active','expired','not_covered')),
  provider_name text,
  contract_reference text,
  starts_at date,
  ends_at date,
  mileage_limit integer,
  covered_components jsonb not null default '[]'::jsonb,
  authorized_network jsonb not null default '{}'::jsonb,
  source text not null default 'customer' check (source in ('customer','dealer','oem','warranty_admin','admin','integration')),
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_warranty_coverages_vehicle on warranty_coverages(vehicle_id,coverage_status,ends_at);

create table if not exists repair_authorization_constraints (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid references service_cases(id) on delete cascade,
  warranty_coverage_id uuid references warranty_coverages(id) on delete cascade,
  constraint_type text not null check (constraint_type in ('authorized_provider','covered_component','preauthorization','oem_procedure','payment_responsibility','other')),
  status text not null default 'required' check (status in ('required','satisfied','waived','not_applicable','blocked')),
  details jsonb not null default '{}'::jsonb,
  source text not null default 'core',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (service_case_id is not null or warranty_coverage_id is not null)
);
create index if not exists idx_repair_authorization_case on repair_authorization_constraints(service_case_id,status);

commit;
