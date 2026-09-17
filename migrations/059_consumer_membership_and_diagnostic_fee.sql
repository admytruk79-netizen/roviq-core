-- Consumer membership tiers (free vs. paid) and the diagnostic coordination fee a non-covered
-- visit charges. Business Plan Section 4: the on-site diagnostic visit itself was never a
-- monetized event on its own -- a "diagnose and fix" job handled directly by the technician
-- currently generates no revenue anywhere in the system. A paid membership plan can waive that
-- fee for a quota of visits per period and unlock a higher loaner tier, the same "included
-- allowance + paid overage" shape already used for shop/dealership billing.

create table if not exists membership_plans (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null unique,
  display_name text not null,
  included_diagnostics_per_period integer not null default 0 check (included_diagnostics_per_period >= 0),
  period_days integer not null default 30 check (period_days > 0),
  max_loaner_tier text not null default 'economy' check (max_loaner_tier in ('economy','standard','luxury')),
  monthly_price_minor integer not null default 0 check (monthly_price_minor >= 0),
  currency text not null default 'USD',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Starting values only -- real pricing is a business decision, not something to leave unmarked as
-- a guess. 'free' has no included visits (every diagnostic is charged the standalone fee) and
-- economy-only loaners; 'plus' is an illustrative paid tier.
insert into membership_plans(plan_key,display_name,included_diagnostics_per_period,period_days,max_loaner_tier,monthly_price_minor,currency)
values
  ('free','Free',0,30,'economy',0,'USD'),
  ('plus','Plus',2,30,'standard',1999,'USD')
on conflict (plan_key) do nothing;

create table if not exists customer_memberships (
  id uuid primary key default gen_random_uuid(),
  customer_actor_id uuid not null unique references actors(id) on delete cascade,
  plan_id uuid not null references membership_plans(id),
  status text not null default 'active' check (status in ('active','cancelled')),
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '30 days'),
  diagnostics_used_this_period integer not null default 0 check (diagnostics_used_this_period >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The diagnostic fee amount itself reuses routing_policies (policy_key='diagnostic_fee_default')
-- rather than a new table -- it's already a generic versioned/active-policy store (domain_id,
-- policy_key, version, active, configuration), already reused for parts_supplier_default, and
-- already has an admin CRUD surface (POST/GET /api/admin/routing-policies) that a new table would
-- have needed its own copy of.
