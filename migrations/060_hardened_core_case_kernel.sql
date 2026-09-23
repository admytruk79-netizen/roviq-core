-- v2.5 hardened Core: universal case kernel, durable events, capability registry and connector inbox/outbox.
-- Additive only: existing service_cases remains authoritative for maintenance while domains migrate onto core_cases.

create table if not exists core_cases (
  id uuid primary key default gen_random_uuid(),
  case_type text not null check (case_type in ('maintenance','transport','mobility','fleet','trade')),
  state text not null default 'intake' check(state in ('intake','triage','active','waiting_external','needs_review','blocked','retry_scheduled','degraded','failed','completed','cancelled','expired')),
  version bigint not null default 1 check (version > 0),
  market_id uuid references markets(id),
  location_id uuid references locations(id),
  customer_actor_id uuid references actors(id),
  current_owner_actor_id uuid references actors(id),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  requirements jsonb not null default '{}'::jsonb,
  constraints jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists core_cases_type_state_idx on core_cases(case_type,state,updated_at desc);
create index if not exists core_cases_customer_idx on core_cases(customer_actor_id,created_at desc);

create table if not exists core_case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references core_cases(id) on delete cascade,
  actor_id uuid references actors(id),
  organization_id uuid references organizations(id),
  event_type text not null,
  correlation_id uuid not null default gen_random_uuid(),
  causation_id uuid,
  schema_version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  payload_hash text,
  previous_version bigint not null,
  new_version bigint not null,
  occurred_at timestamptz not null default now(),
  unique(case_id,new_version)
);
create index if not exists core_case_events_case_time_idx on core_case_events(case_id,occurred_at,id);

create table if not exists core_capabilities (
  id uuid primary key default gen_random_uuid(),
  capability_key text not null,
  actor_id uuid references actors(id),
  organization_id uuid references organizations(id),
  connector_key text,
  status text not null default 'active' check(status in ('active','inactive','degraded')),
  operations jsonb not null default '[]'::jsonb,
  geography jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  health jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists core_capabilities_identity_idx
  on core_capabilities(capability_key,coalesce(actor_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(connector_key,''));

create table if not exists core_connector_inbox (
  id uuid primary key default gen_random_uuid(),
  connector_key text not null,
  external_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check(status in ('received','processed','failed','ignored')),
  error text,
  unique(connector_key,external_event_id)
);

create table if not exists core_outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  available_at timestamptz not null default now()
);
create index if not exists core_outbox_ready_idx on core_outbox(available_at,created_at) where published_at is null;
create index if not exists core_outbox_pending_idx on core_outbox(created_at) where published_at is null;

-- Command idempotency reuses the established idempotency_keys table/service so all Core commands share one concurrency-safe implementation.
