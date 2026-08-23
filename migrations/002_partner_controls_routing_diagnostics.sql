create table if not exists partner_controls (
  actor_id uuid primary key references actors(id) on delete cascade,
  routing_enabled boolean not null default true,
  accepts_overflow boolean not null default false,
  releases_overflow boolean not null default false,
  service_radius_miles numeric,
  operating_hours_json jsonb not null default '{}'::jsonb,
  accepted_job_types_json jsonb not null default '[]'::jsonb,
  excluded_job_types_json jsonb not null default '[]'::jsonb,
  oem_warranty_rules_json jsonb not null default '{}'::jsonb,
  max_active_jobs integer,
  earliest_available_at timestamptz,
  loaner_participation boolean not null default false,
  valet_participation boolean not null default false,
  tow_participation boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists partner_relationship_rules (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references actors(id) on delete cascade,
  rule_kind text not null,
  subject text,
  configuration jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists partner_relationship_rules_actor_idx on partner_relationship_rules(actor_id,active);

create table if not exists diagnostic_findings (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid not null references demand_requests(id) on delete cascade,
  diagnostic_actor_id uuid not null references actors(id),
  finding_code text,
  summary text not null,
  drivability text not null check (drivability in ('drivable','limited','non_drivable','unknown')),
  disposition text not null check (disposition in ('diagnose_only','diagnose_and_fix','route_to_shop','route_to_tow')),
  confidence numeric check (confidence between 0 and 1),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists diagnostic_findings_demand_idx on diagnostic_findings(demand_id,created_at);

create table if not exists routing_decisions (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid not null references demand_requests(id) on delete cascade,
  rule_version integer not null default 1,
  evaluated_at timestamptz not null default now(),
  eligible_actor_ids jsonb not null default '[]'::jsonb,
  rejected_candidates jsonb not null default '[]'::jsonb,
  ranking_trace jsonb not null default '[]'::jsonb,
  selected_actor_id uuid references actors(id),
  decision_basis text not null
);
create index if not exists routing_decisions_demand_idx on routing_decisions(demand_id,evaluated_at desc);
