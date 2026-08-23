create table if not exists integration_clients (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references actors(id) on delete cascade,
  name text not null,
  key_prefix text not null unique,
  key_hash text not null,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active','revoked')),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists integration_clients_actor_idx on integration_clients(actor_id,status);

create table if not exists webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references actors(id) on delete cascade,
  endpoint_url text not null,
  secret text not null,
  event_types text[] not null default '{}',
  status text not null default 'active' check (status in ('active','paused','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists webhook_subscriptions_actor_idx on webhook_subscriptions(actor_id,status);

create table if not exists integration_events (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid,
  event_type text not null,
  actor_id uuid references actors(id),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists integration_events_type_idx on integration_events(event_type,occurred_at desc);

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references webhook_subscriptions(id) on delete cascade,
  integration_event_id uuid not null references integration_events(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','processing','delivered','retry','dead')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  response_code integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique(subscription_id,integration_event_id)
);
create index if not exists webhook_deliveries_pending_idx on webhook_deliveries(state,available_at);
