create table if not exists payment_intents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  customer_actor_id uuid references actors(id),
  provider text not null default 'manual',
  provider_intent_id text,
  amount numeric(14,2) not null check (amount >= 0),
  currency char(3) not null default 'USD',
  state text not null default 'created' check (state in ('created','requires_action','authorized','captured','partially_refunded','refunded','cancelled','failed')),
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  authorized_at timestamptz,
  captured_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists payment_intents_case_idx on payment_intents(case_id,created_at desc);
create unique index if not exists payment_intents_provider_ref_idx on payment_intents(provider,provider_intent_id) where provider_intent_id is not null;

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null references payment_intents(id) on delete cascade,
  event_type text not null,
  amount numeric(14,2),
  provider_event_id text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists payment_events_intent_idx on payment_events(payment_intent_id,occurred_at);
create unique index if not exists payment_events_provider_event_idx on payment_events(provider_event_id) where provider_event_id is not null;

create table if not exists settlement_payouts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  counterparty_actor_id uuid not null references actors(id),
  payment_intent_id uuid references payment_intents(id) on delete set null,
  amount numeric(14,2) not null check (amount >= 0),
  currency char(3) not null default 'USD',
  state text not null default 'pending' check (state in ('pending','approved','processing','paid','failed','cancelled')),
  provider text not null default 'manual',
  provider_payout_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists settlement_payouts_case_idx on settlement_payouts(case_id,created_at desc);
create index if not exists settlement_payouts_counterparty_idx on settlement_payouts(counterparty_actor_id,state);

alter table ledger_entries add column if not exists payment_intent_id uuid references payment_intents(id) on delete set null;
alter table ledger_entries add column if not exists payout_id uuid references settlement_payouts(id) on delete set null;
