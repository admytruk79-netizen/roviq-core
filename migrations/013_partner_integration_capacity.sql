-- ROVIQ Core migration 013
-- Partner systems integration, canonical capacity, and ROVIQ-native scheduling.
-- This closes the live-capacity gap: routing must consume normalized capacity,
-- not raw vendor schemas or informal partner self-reporting.

begin;

create table if not exists partner_system_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  mode text not null check (mode in ('native_integration','roviq_native','bridge')),
  provider_key text not null default 'roviq',
  display_name text,
  connection_status text not null default 'planned' check (connection_status in ('planned','active','paused','degraded','revoked','failed')),
  read_scope jsonb not null default '{}'::jsonb,
  write_scope jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_partner_system_connections_org on partner_system_connections(organization_id);
create index if not exists idx_partner_system_connections_location on partner_system_connections(location_id);
create index if not exists idx_partner_system_connections_status on partner_system_connections(connection_status);

create table if not exists partner_external_refs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references partner_system_connections(id) on delete cascade,
  roviq_entity_type text not null,
  roviq_entity_id uuid,
  external_entity_type text not null,
  external_entity_id text not null,
  external_version text,
  payload_hash text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (connection_id, external_entity_type, external_entity_id)
);

create table if not exists service_resources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  resource_type text not null check (resource_type in ('bay','technician','advisor','mobile_unit','tow_unit','valet_driver','loaner_vehicle')),
  display_name text not null,
  active boolean not null default true,
  capability_tags text[] not null default '{}',
  constraints jsonb not null default '{}'::jsonb,
  source_connection_id uuid references partner_system_connections(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_service_resources_location_type on service_resources(location_id, resource_type);
create index if not exists idx_service_resources_active on service_resources(active);

create table if not exists capacity_windows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  source_connection_id uuid references partner_system_connections(id) on delete set null,
  resource_id uuid references service_resources(id) on delete set null,
  service_category text,
  window_start timestamptz not null,
  window_end timestamptz not null,
  capacity_state text not null check (capacity_state in ('available','limited','blocked','reserved','full','unknown')),
  capacity_units integer not null default 1 check (capacity_units >= 0),
  confidence text not null default 'declared' check (confidence in ('integrated','roviq_native','manual_verified','declared','stale','unknown')),
  constraint_summary jsonb not null default '{}'::jsonb,
  sync_state text not null default 'current' check (sync_state in ('current','stale','degraded','manual','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_end > window_start)
);

create index if not exists idx_capacity_windows_lookup on capacity_windows(location_id, service_category, window_start, window_end);
create index if not exists idx_capacity_windows_state on capacity_windows(capacity_state, sync_state);

create table if not exists roviq_appointments (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid references service_cases(id) on delete set null,
  organization_id uuid references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  resource_id uuid references service_resources(id) on delete set null,
  source_connection_id uuid references partner_system_connections(id) on delete set null,
  appointment_status text not null default 'held' check (appointment_status in ('held','confirmed','in_progress','completed','cancelled','no_show','released')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  service_category text,
  customer_visible_summary text,
  internal_notes text,
  created_by_actor_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists idx_roviq_appointments_case on roviq_appointments(service_case_id);
create index if not exists idx_roviq_appointments_location_time on roviq_appointments(location_id, starts_at, ends_at);
create index if not exists idx_roviq_appointments_status on roviq_appointments(appointment_status);

create table if not exists integration_sync_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references partner_system_connections(id) on delete cascade,
  event_type text not null,
  direction text not null check (direction in ('inbound','outbound','internal')),
  status text not null check (status in ('accepted','ignored','failed','replayed')),
  correlation_id text,
  external_entity_type text,
  external_entity_id text,
  roviq_entity_type text,
  roviq_entity_id uuid,
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_integration_sync_events_connection on integration_sync_events(connection_id, created_at desc);
create index if not exists idx_integration_sync_events_correlation on integration_sync_events(correlation_id);

commit;
