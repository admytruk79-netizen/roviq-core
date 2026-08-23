create table if not exists dispatch_attempts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  demand_id uuid references demand_requests(id),
  actor_id uuid references actors(id),
  dispatch_type text not null,
  sequence integer not null,
  state text not null default 'offered',
  offered_at timestamptz not null default now(),
  expires_at timestamptz,
  responded_at timestamptz,
  response text,
  metadata jsonb not null default '{}'::jsonb,
  unique(case_id,dispatch_type,sequence)
);
create index if not exists dispatch_attempts_case_idx on dispatch_attempts(case_id,dispatch_type,state);

create table if not exists notification_outbox (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references service_cases(id) on delete cascade,
  event_id uuid references events(id) on delete set null,
  channel text not null,
  recipient_type text not null,
  recipient_id text not null,
  template_key text not null,
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending',
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_outbox_pending_idx on notification_outbox(state,available_at);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references service_cases(id),
  transaction_id uuid references transactions(id),
  entry_type text not null,
  account_code text not null,
  counterparty_actor_id uuid references actors(id),
  amount numeric(14,2) not null,
  currency char(3) not null default 'USD',
  state text not null default 'pending',
  external_reference text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists ledger_case_idx on ledger_entries(case_id,occurred_at);

create table if not exists case_snapshots (
  case_id uuid primary key references service_cases(id) on delete cascade,
  customer_status text not null,
  customer_message text,
  next_action text,
  eta_at timestamptz,
  updated_at timestamptz not null default now()
);
