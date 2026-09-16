-- Referral fee policy: the platform's actual monetization mechanism per the Business Plan
-- ("shop... pays a referral fee scaled to job complexity") -- versioned and domain-scoped like
-- routing_policies, so the real percentages are a data change, not a code change.
create table if not exists referral_fee_policies (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references domains(id),
  policy_key text not null default 'referral_fee_default',
  version integer not null default 1,
  active boolean not null default true,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(domain_id, policy_key, version)
);
create index if not exists referral_fee_policies_active_idx on referral_fee_policies(domain_id, policy_key, active);

-- A conservative starting tier structure: higher-value jobs pay a lower marginal percentage.
-- These are real business numbers that should be tuned by the account owner, not treated as final.
insert into referral_fee_policies(domain_id, policy_key, version, active, configuration)
select d.id, 'referral_fee_default', 1, true, jsonb_build_object(
  'currency','USD',
  'tiers', jsonb_build_array(
    jsonb_build_object('maxAmountMinor',10000,'percent',15),
    jsonb_build_object('maxAmountMinor',50000,'percent',12),
    jsonb_build_object('maxAmountMinor',null,'percent',10)
  )
)
from domains d where d.code='maintenance'
on conflict (domain_id, policy_key, version) do nothing;

-- Add-to-order: shop-flagged findings during a job, with the three-tier customer-approval model
-- from Business Plan Section 4A (Critical/Urgent/Flexible).
create table if not exists case_addon_items (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  service_plan_id uuid references service_plans(id) on delete set null,
  flagged_by_actor_id uuid references actors(id),
  severity text not null check (severity in ('critical','urgent','flexible')),
  description text not null,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency char(3) not null default 'USD',
  status text not null default 'pending' check (status in (
    'pending','approved','declined_acknowledged','deferred','sent_for_competing_quote','cancelled'
  )),
  decision_reason text,
  decided_by_actor_id uuid references actors(id),
  decided_at timestamptz,
  competing_quote_demand_id uuid references demand_requests(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists case_addon_items_case_idx on case_addon_items(case_id, status, created_at);

-- Flexible-severity items can be shopped to a different partner for a competing quote (Business
-- Plan Section 4A) without spinning up a second service_case for the same repair job -- a
-- lightweight bidding board scoped to the one flagged item.
create table if not exists addon_competing_quotes (
  id uuid primary key default gen_random_uuid(),
  addon_item_id uuid not null references case_addon_items(id) on delete cascade,
  quoting_actor_id uuid not null references actors(id),
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null default 'USD',
  notes text,
  status text not null default 'submitted' check (status in ('submitted','selected','declined')),
  created_at timestamptz not null default now(),
  unique(addon_item_id, quoting_actor_id)
);
create index if not exists addon_competing_quotes_item_idx on addon_competing_quotes(addon_item_id, status);
