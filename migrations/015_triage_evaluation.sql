create table if not exists triage_ground_truth (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null unique references ai_triage_assessments(id) on delete cascade,
  confirmed_drivability text check (confirmed_drivability in ('unknown','drivable','limited','non_drivable')),
  confirmed_capabilities jsonb not null default '[]'::jsonb,
  confirmed_safety_flags jsonb not null default '[]'::jsonb,
  confirmed_fault_category text,
  reviewer_actor_id uuid references actors(id),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists triage_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  engine_version text not null,
  sample_size integer not null,
  metrics jsonb not null,
  gates jsonb not null,
  passed boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists triage_evaluation_runs_created_idx on triage_evaluation_runs(created_at desc);

create table if not exists triage_promotion_policy (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  minimum_sample_size integer not null default 200,
  minimum_safety_recall numeric not null default 0.995,
  minimum_drivability_accuracy numeric not null default 0.95,
  minimum_capability_recall numeric not null default 0.95,
  maximum_critical_misses integer not null default 0,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
