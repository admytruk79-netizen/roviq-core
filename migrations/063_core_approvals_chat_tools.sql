-- Universal approval binding and controlled tool invocation audit.
create table if not exists core_approvals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references core_cases(id) on delete cascade,
  approval_type text not null,
  action text not null,
  state text not null default 'pending' check(state in ('pending','approved','rejected','expired','cancelled')),
  requested_from_actor_id uuid references actors(id),
  requested_by_actor_id uuid references actors(id),
  expected_case_version bigint,
  payload jsonb not null default '{}'::jsonb,
  reason text,
  expires_at timestamptz,
  decided_at timestamptz,
  decided_by_actor_id uuid references actors(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists core_approvals_case_idx on core_approvals(case_id,created_at desc);
create index if not exists core_approvals_pending_idx on core_approvals(requested_from_actor_id,created_at desc) where state='pending';

create table if not exists core_tool_invocations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references core_cases(id) on delete set null,
  tool_name text not null,
  principal_role text not null,
  principal_actor_id uuid references actors(id),
  request jsonb not null default '{}'::jsonb,
  outcome text not null check(outcome in ('started','succeeded','denied','failed')),
  response jsonb,
  error text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists core_tool_invocations_case_idx on core_tool_invocations(case_id,created_at desc);
