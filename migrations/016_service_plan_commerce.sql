create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  owner_actor_id uuid references actors(id),
  vin text,
  year integer check (year is null or year between 1886 and 2200),
  make text,
  model text,
  trim text,
  powertrain text,
  odometer_value integer check (odometer_value is null or odometer_value >= 0),
  odometer_unit text not null default 'miles' check (odometer_unit in ('miles','kilometers')),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists vehicles_vin_uidx on vehicles(upper(vin)) where vin is not null;
create index if not exists vehicles_owner_idx on vehicles(owner_actor_id,updated_at desc);

create table if not exists vehicle_authorizations (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  authorization_type text not null check (authorization_type in ('owner','driver','fleet_manager','service_consent')),
  granted_by_actor_id uuid references actors(id),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists vehicle_authorizations_actor_idx on vehicle_authorizations(actor_id,vehicle_id,starts_at desc);

alter table service_cases add column if not exists vehicle_id uuid references vehicles(id);
create index if not exists service_cases_vehicle_idx on service_cases(vehicle_id,created_at desc);

create table if not exists service_plans (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','proposed','approved','in_progress','completed','cancelled')),
  current_revision integer not null default 1 check (current_revision > 0),
  customer_summary text,
  currency char(3) not null default 'USD',
  estimated_total_minor bigint check (estimated_total_minor is null or estimated_total_minor >= 0),
  approved_total_minor bigint check (approved_total_minor is null or approved_total_minor >= 0),
  created_by_actor_id uuid references actors(id),
  approved_by_actor_id uuid references actors(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(case_id)
);

create table if not exists service_plan_revisions (
  id uuid primary key default gen_random_uuid(),
  service_plan_id uuid not null references service_plans(id) on delete cascade,
  revision integer not null check (revision > 0),
  change_reason text not null,
  customer_summary text,
  plan_snapshot jsonb not null default '{}'::jsonb,
  estimated_total_minor bigint check (estimated_total_minor is null or estimated_total_minor >= 0),
  currency char(3) not null default 'USD',
  created_by_actor_id uuid references actors(id),
  created_at timestamptz not null default now(),
  unique(service_plan_id,revision)
);

create table if not exists service_plan_tasks (
  id uuid primary key default gen_random_uuid(),
  service_plan_id uuid not null references service_plans(id) on delete cascade,
  revision integer not null check (revision > 0),
  task_type text not null,
  sequence integer not null default 0,
  status text not null default 'pending' check (status in ('pending','ready','assigned','in_progress','blocked','completed','cancelled')),
  assigned_actor_id uuid references actors(id),
  title text not null,
  instructions text,
  due_at timestamptz,
  estimated_amount_minor bigint check (estimated_amount_minor is null or estimated_amount_minor >= 0),
  currency char(3) not null default 'USD',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists service_plan_tasks_plan_idx on service_plan_tasks(service_plan_id,revision,sequence);
create index if not exists service_plan_tasks_assignee_idx on service_plan_tasks(assigned_actor_id,status,due_at);

create table if not exists case_commitments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  service_plan_id uuid references service_plans(id) on delete cascade,
  commitment_type text not null,
  provider_actor_id uuid references actors(id),
  state text not null default 'proposed' check (state in ('proposed','accepted','declined','expired','fulfilled','cancelled')),
  starts_at timestamptz,
  due_at timestamptz,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency char(3) not null default 'USD',
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  fulfilled_at timestamptz
);
create index if not exists case_commitments_case_idx on case_commitments(case_id,state,due_at);

create table if not exists case_approvals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  service_plan_id uuid references service_plans(id) on delete cascade,
  revision integer,
  approval_type text not null,
  state text not null default 'pending' check (state in ('pending','approved','rejected','expired','revoked')),
  requested_from_actor_id uuid references actors(id),
  requested_by_actor_id uuid references actors(id),
  decision_by_actor_id uuid references actors(id),
  decision_reason text,
  amount_minor bigint,
  currency char(3) not null default 'USD',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists case_approvals_pending_idx on case_approvals(requested_from_actor_id,state,expires_at);

create table if not exists commercial_products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  product_type text not null check (product_type in ('partner_subscription','diagnostic_coordination','case_coordination','transport','parts','customer_membership','prepaid_plan','enterprise')),
  name text not null,
  description text,
  active boolean not null default true,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists price_books (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  market_id uuid references markets(id),
  audience_type text not null check (audience_type in ('customer','partner','fleet','enterprise')),
  currency char(3) not null default 'USD',
  starts_at timestamptz not null,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  unique(code,starts_at)
);

create table if not exists price_book_items (
  id uuid primary key default gen_random_uuid(),
  price_book_id uuid not null references price_books(id) on delete cascade,
  product_id uuid not null references commercial_products(id),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  billing_interval text not null default 'one_time' check (billing_interval in ('one_time','monthly','annual')),
  conditions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(price_book_id,product_id,billing_interval)
);

create table if not exists service_quotes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  service_plan_id uuid references service_plans(id),
  revision integer not null default 1,
  seller_actor_id uuid references actors(id),
  customer_actor_id uuid references actors(id),
  status text not null default 'draft' check (status in ('draft','presented','accepted','declined','expired','superseded','cancelled')),
  subtotal_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null default 0,
  currency char(3) not null default 'USD',
  expires_at timestamptz,
  presented_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(case_id,revision)
);

create table if not exists service_quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references service_quotes(id) on delete cascade,
  product_id uuid references commercial_products(id),
  line_type text not null check (line_type in ('diagnostic','coordination','labor','part','transport','tax','discount','credit','other')),
  description text not null,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_amount_minor bigint not null,
  line_amount_minor bigint not null,
  merchant_actor_id uuid references actors(id),
  revenue_recognition text not null default 'gross' check (revenue_recognition in ('gross','net','pass_through')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists plan_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  plan_type text not null check (plan_type in ('membership','prepaid_care','partner_subscription')),
  name text not null,
  version integer not null default 1,
  status text not null default 'draft' check (status in ('draft','active','retired')),
  starts_at timestamptz,
  ends_at timestamptz,
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table if not exists plan_entitlements (
  id uuid primary key default gen_random_uuid(),
  plan_definition_id uuid not null references plan_definitions(id) on delete cascade,
  entitlement_code text not null,
  quantity numeric(12,3),
  period text check (period is null or period in ('case','month','year','term')),
  value_limit_minor bigint,
  eligibility jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(plan_definition_id,entitlement_code)
);

create table if not exists actor_subscriptions (
  id uuid primary key default gen_random_uuid(),
  subscriber_actor_id uuid not null references actors(id),
  plan_definition_id uuid not null references plan_definitions(id),
  status text not null default 'trialing' check (status in ('trialing','active','past_due','paused','cancelled','expired')),
  external_customer_reference text,
  external_subscription_reference text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists actor_subscriptions_active_idx on actor_subscriptions(subscriber_actor_id,status,current_period_end);

create table if not exists entitlement_balances (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references actor_subscriptions(id) on delete cascade,
  entitlement_id uuid not null references plan_entitlements(id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  granted_quantity numeric(12,3),
  consumed_quantity numeric(12,3) not null default 0,
  granted_value_minor bigint,
  consumed_value_minor bigint not null default 0,
  updated_at timestamptz not null default now(),
  check (period_end > period_start),
  check (consumed_quantity >= 0 and consumed_value_minor >= 0),
  unique(subscription_id,entitlement_id,period_start)
);

create table if not exists entitlement_redemptions (
  id uuid primary key default gen_random_uuid(),
  balance_id uuid not null references entitlement_balances(id),
  case_id uuid references service_cases(id),
  quantity numeric(12,3),
  value_minor bigint,
  idempotency_key text not null unique,
  state text not null default 'reserved' check (state in ('reserved','consumed','released','reversed')),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  reversed_at timestamptz
);

create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null references payment_intents(id),
  case_id uuid references service_cases(id),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  status text not null default 'requested' check (status in ('requested','submitted','succeeded','failed','cancelled')),
  reason text,
  external_reference text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payment_disputes (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null references payment_intents(id),
  external_reference text not null unique,
  status text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'USD',
  reason text,
  evidence_due_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists revenue_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid references payment_intents(id),
  quote_line_id uuid references service_quote_lines(id),
  case_id uuid references service_cases(id),
  allocation_type text not null check (allocation_type in ('platform_revenue','partner_payable','tax_payable','processor_fee','refund','reserve')),
  amount_minor bigint not null,
  currency char(3) not null default 'USD',
  recognition_basis text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists revenue_allocations_case_idx on revenue_allocations(case_id,occurred_at);

create table if not exists domain_outbox (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid not null default gen_random_uuid(),
  idempotency_key text unique,
  state text not null default 'pending' check (state in ('pending','processing','published','failed','dead_letter')),
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists domain_outbox_pending_idx on domain_outbox(state,available_at,created_at);

create unique index if not exists parts_inventory_scope_uidx
  on parts_inventory(supplier_actor_id,sku,location_id) nulls not distinct;
