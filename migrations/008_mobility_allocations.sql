create table if not exists mobility_resources (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references actors(id) on delete cascade,
  resource_type text not null check (resource_type in ('loaner','rental','rideshare_credit','shuttle','valet_return','other')),
  external_reference text,
  label text,
  status text not null default 'available' check (status in ('available','reserved','assigned','maintenance','offline','retired')),
  location_id uuid references locations(id),
  attributes jsonb not null default '{}'::jsonb,
  available_from timestamptz,
  available_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mobility_resources_actor_status_idx on mobility_resources(actor_id,status);

create table if not exists mobility_allocations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  customer_actor_id uuid references actors(id),
  provider_actor_id uuid references actors(id),
  resource_id uuid references mobility_resources(id),
  allocation_type text not null,
  state text not null default 'requested' check (state in ('requested','reserved','assigned','active','return_pending','completed','declined','cancelled','failed')),
  requested_at timestamptz not null default now(),
  reserved_at timestamptz,
  assigned_at timestamptz,
  activated_at timestamptz,
  return_due_at timestamptz,
  returned_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mobility_allocations_case_idx on mobility_allocations(case_id,created_at desc);
create index if not exists mobility_allocations_provider_idx on mobility_allocations(provider_actor_id,state);
create unique index if not exists mobility_allocations_active_resource_uidx on mobility_allocations(resource_id)
where state in ('reserved','assigned','active','return_pending');
