create extension if not exists pgcrypto;

create table if not exists domains (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  status text not null default 'active',
  configuration_version integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists visibility_policies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role_domain_scope jsonb not null default '{}'::jsonb,
  allowed_fields jsonb not null default '[]'::jsonb,
  row_predicate jsonb not null default '{}'::jsonb,
  purpose text,
  created_at timestamptz not null default now()
);

create table if not exists actors (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references domains(id),
  actor_type text not null,
  legal_entity_id text,
  status text not null default 'active',
  visibility_policy_id uuid references visibility_policies(id),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists actors_type_idx on actors(actor_type,status);

create table if not exists capabilities (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references domains(id),
  capability_code text not null,
  attributes jsonb not null default '{}'::jsonb,
  certification_requirements jsonb not null default '{}'::jsonb,
  unique(domain_id, capability_code)
);

create table if not exists actor_capabilities (
  actor_id uuid not null references actors(id) on delete cascade,
  capability_id uuid not null references capabilities(id) on delete cascade,
  commercial_terms_id text,
  active boolean not null default true,
  primary key(actor_id, capability_id)
);

create table if not exists resources (
  id uuid primary key default gen_random_uuid(),
  resource_type text not null,
  owner_actor_id uuid not null references actors(id),
  location_id text,
  state text not null default 'available',
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists resources_owner_idx on resources(owner_actor_id,resource_type,state);

create table if not exists capacity_snapshots (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references actors(id),
  resource_id uuid references resources(id),
  capacity_type text not null,
  quantity numeric not null check(quantity >= 0),
  start_at timestamptz not null,
  end_at timestamptz not null,
  source text not null,
  confidence numeric not null default 1 check(confidence between 0 and 1),
  created_at timestamptz not null default now(),
  check(actor_id is not null or resource_id is not null),
  check(end_at > start_at)
);
create index if not exists capacity_actor_time_idx on capacity_snapshots(actor_id,start_at,end_at);

create table if not exists demand_requests (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references domains(id),
  requester_actor_id uuid references actors(id),
  demand_type text not null,
  location jsonb,
  urgency text not null default 'normal',
  attributes jsonb not null default '{}'::jsonb,
  state text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists demand_domain_state_idx on demand_requests(domain_id,state,created_at);

create table if not exists rules (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references domains(id),
  rule_type text not null,
  priority integer not null,
  predicate_json jsonb not null default '{}'::jsonb,
  action_json jsonb not null default '{}'::jsonb,
  hard_filter_boolean boolean not null default false,
  version integer not null default 1,
  active boolean not null default true
);

create table if not exists matches_offers (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid not null references demand_requests(id),
  actor_id uuid references actors(id),
  resource_id uuid references resources(id),
  score numeric,
  rank integer,
  rule_basis text,
  offered_at timestamptz not null default now(),
  responded_at timestamptz,
  outcome text not null default 'offered',
  check(actor_id is not null or resource_id is not null)
);
create index if not exists offers_actor_outcome_idx on matches_offers(actor_id,outcome,offered_at);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references domains(id),
  demand_id uuid references demand_requests(id),
  provider_actor_id uuid references actors(id),
  transaction_type text not null,
  amount numeric,
  terms jsonb not null default '{}'::jsonb,
  state text not null,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  actor_id uuid references actors(id),
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid default gen_random_uuid()
);
create index if not exists events_aggregate_idx on events(aggregate_type,aggregate_id,occurred_at);

create table if not exists performance_metrics (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references actors(id),
  resource_id uuid references resources(id),
  metric_code text not null,
  period tstzrange,
  value numeric not null,
  sample_size integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  principal_role text not null,
  principal_actor_id uuid,
  action text not null,
  object_type text not null,
  object_id text not null,
  rule_basis text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists audit_object_idx on audit_log(object_type,object_id,occurred_at);

insert into domains(code,status,configuration_version)
values ('maintenance','active',1), ('station','inactive',1)
on conflict(code) do nothing;

insert into capabilities(domain_id, capability_code, attributes)
select d.id, x.code, '{}'::jsonb
from domains d
cross join (values ('repair'),('diagnostics'),('tow'),('valet'),('loaner'),('parts_supply')) x(code)
where d.code='maintenance'
on conflict(domain_id,capability_code) do nothing;
