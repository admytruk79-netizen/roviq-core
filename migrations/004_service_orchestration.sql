create table if not exists service_cases (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references domains(id),
  demand_id uuid references demand_requests(id),
  customer_actor_id uuid references actors(id),
  market_id uuid references markets(id),
  location_id uuid references locations(id),
  case_type text not null default 'maintenance',
  state text not null default 'intake',
  priority text not null default 'normal',
  drivability text not null default 'unknown',
  current_owner_role text,
  current_owner_actor_id uuid references actors(id),
  attributes jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists service_cases_customer_idx on service_cases(customer_actor_id,created_at desc);
create index if not exists service_cases_state_idx on service_cases(state,priority,updated_at);
create index if not exists service_cases_owner_idx on service_cases(current_owner_actor_id,state);

create table if not exists case_links (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  object_type text not null,
  object_id uuid not null,
  relation text not null,
  created_at timestamptz not null default now(),
  unique(case_id, object_type, object_id, relation)
);
create index if not exists case_links_object_idx on case_links(object_type,object_id);

create table if not exists case_transition_rules (
  from_state text not null,
  to_state text not null,
  allowed_roles text[] not null,
  terminal boolean not null default false,
  primary key(from_state,to_state)
);

insert into case_transition_rules(from_state,to_state,allowed_roles,terminal) values
('intake','triage',array['customer','admin'],false),
('triage','diagnostic_pending',array['admin'],false),
('triage','provider_selection',array['admin'],false),
('triage','tow_pending',array['admin'],false),
('diagnostic_pending','diagnostic_in_progress',array['diagnostic','admin'],false),
('diagnostic_in_progress','provider_selection',array['diagnostic','admin'],false),
('diagnostic_in_progress','tow_pending',array['diagnostic','admin'],false),
('diagnostic_in_progress','repair_in_progress',array['diagnostic','admin'],false),
('tow_pending','tow_in_progress',array['tow','admin'],false),
('tow_in_progress','provider_selection',array['tow','admin'],false),
('provider_selection','provider_pending',array['customer','admin'],false),
('provider_pending','repair_in_progress',array['partner','admin'],false),
('provider_pending','provider_selection',array['partner','admin'],false),
('repair_in_progress','parts_pending',array['partner','admin'],false),
('parts_pending','repair_in_progress',array['parts','partner','admin'],false),
('repair_in_progress','payment_pending',array['partner','admin'],false),
('payment_pending','completed',array['admin'],true)
on conflict(from_state,to_state) do nothing;

create table if not exists workflow_deadlines (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  deadline_type text not null,
  due_at timestamptz not null,
  state text not null default 'open',
  retry_count integer not null default 0,
  max_retries integer not null default 3,
  fallback_action text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists workflow_deadlines_open_idx on workflow_deadlines(state,due_at);

create table if not exists case_exceptions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  exception_code text not null,
  severity text not null default 'warning',
  state text not null default 'open',
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_actor_id uuid references actors(id)
);
create index if not exists case_exceptions_open_idx on case_exceptions(state,severity,created_at);

create table if not exists idempotency_keys (
  key text primary key,
  principal_role text not null,
  principal_actor_id uuid,
  operation text not null,
  request_hash text,
  response_code integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

alter table diagnostic_findings add column if not exists case_id uuid references service_cases(id);
alter table matches_offers add column if not exists case_id uuid references service_cases(id);
alter table transactions add column if not exists case_id uuid references service_cases(id);
