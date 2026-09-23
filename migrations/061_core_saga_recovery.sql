-- Durable saga/recovery foundation for universal Core cases.
create table if not exists core_sagas (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references core_cases(id) on delete cascade,
  saga_type text not null,
  state text not null default 'running' check(state in ('running','waiting','retry_scheduled','compensating','needs_review','completed','cancelled','failed')),
  current_step text,
  version bigint not null default 1 check(version>0),
  context jsonb not null default '{}'::jsonb,
  next_action_at timestamptz,
  deadline_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists core_sagas_case_idx on core_sagas(case_id,updated_at desc);
create index if not exists core_sagas_ready_idx on core_sagas(next_action_at) where state in ('running','retry_scheduled') and next_action_at is not null;

create table if not exists core_saga_steps (
  id uuid primary key default gen_random_uuid(),
  saga_id uuid not null references core_sagas(id) on delete cascade,
  step_key text not null,
  attempt integer not null default 1 check(attempt>0),
  state text not null check(state in ('pending','running','waiting_external','succeeded','failed','compensating','compensated','needs_review','cancelled')),
  idempotency_key text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  unique(saga_id,step_key,attempt),
  unique(idempotency_key)
);
create index if not exists core_saga_steps_ready_idx on core_saga_steps(next_attempt_at) where state in ('pending','failed') and next_attempt_at is not null;
