create table if not exists transport_dispatches (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  transport_type text not null check (transport_type in ('tow','valet')),
  provider_actor_id uuid references actors(id),
  status text not null default 'requested' check (status in ('requested','assigned','accepted','en_route','arrived','vehicle_loaded','in_transit','delivered','declined','cancelled','failed')),
  pickup_location jsonb not null default '{}'::jsonb,
  dropoff_location jsonb not null default '{}'::jsonb,
  vehicle_context jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  assigned_at timestamptz,
  accepted_at timestamptz,
  en_route_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  eta_at timestamptz,
  external_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists transport_dispatches_case_idx on transport_dispatches(case_id,created_at desc);
create index if not exists transport_dispatches_provider_idx on transport_dispatches(provider_actor_id,status,created_at desc);

insert into case_transition_rules(from_state,to_state,allowed_roles,terminal) values
('tow_in_progress','repair_in_progress',array['tow','admin'],false),
('tow_in_progress','diagnostic_pending',array['tow','admin'],false)
on conflict(from_state,to_state) do nothing;
