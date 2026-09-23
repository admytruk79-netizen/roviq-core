-- Deterministic Core policy/constraint engine.
create table if not exists core_policy_rules (
  id uuid primary key default gen_random_uuid(),
  policy_code text not null unique,
  action text not null,
  effect text not null check(effect in ('allow','deny','require_review')),
  priority integer not null default 100,
  enabled boolean not null default true,
  case_type text,
  from_state text,
  to_state text,
  actor_role text,
  predicate jsonb not null default '{}'::jsonb,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists core_policy_rules_eval_idx
  on core_policy_rules(action,enabled,priority desc);

create table if not exists core_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references core_cases(id) on delete cascade,
  action text not null,
  decision text not null check(decision in ('allow','deny','require_review')),
  actor_id uuid references actors(id),
  actor_role text not null,
  matched_rule_ids uuid[] not null default '{}',
  reason text not null,
  facts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists core_policy_decisions_case_idx
  on core_policy_decisions(case_id,created_at desc);
