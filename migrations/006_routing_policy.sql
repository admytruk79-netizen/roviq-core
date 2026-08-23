create table if not exists routing_policies (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references domains(id) on delete cascade,
  policy_key text not null,
  version integer not null default 1,
  active boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(domain_id, policy_key, version)
);

create unique index if not exists routing_policies_one_active_idx
  on routing_policies(domain_id, policy_key)
  where active = true;

alter table routing_decisions
  add column if not exists policy_id uuid references routing_policies(id),
  add column if not exists policy_version integer;
