alter table ai_triage_assessments add column if not exists engine_version text;
alter table ai_triage_assessments add column if not exists deployment_mode text not null default 'shadow' check (deployment_mode in ('shadow','advisory','assisted'));
alter table ai_triage_assessments add column if not exists safety_override boolean not null default false;
alter table ai_triage_assessments add column if not exists safety_override_reason text;
alter table ai_triage_assessments add column if not exists raw_model_output jsonb not null default '{}'::jsonb;
alter table ai_triage_assessments add column if not exists latency_ms integer;

create table if not exists ai_triage_outcomes (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null unique references ai_triage_assessments(id) on delete cascade,
  case_id uuid not null references service_cases(id) on delete cascade,
  confirmed_drivability text,
  confirmed_capabilities jsonb not null default '[]'::jsonb,
  confirmed_fault_category text,
  tow_required boolean,
  safety_critical boolean,
  diagnostic_summary text,
  repair_summary text,
  labeled_by_actor_id uuid references actors(id),
  labeled_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists ai_triage_outcomes_case_idx on ai_triage_outcomes(case_id,labeled_at desc);

create table if not exists ai_triage_eval_runs (
  id uuid primary key default gen_random_uuid(),
  engine_version text not null,
  dataset_name text not null,
  sample_count integer not null default 0,
  safety_recall numeric,
  drivability_accuracy numeric,
  capability_accuracy numeric,
  tow_recall numeric,
  tow_precision numeric,
  confidence_error numeric,
  hallucination_rate numeric,
  passed boolean not null default false,
  thresholds jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ai_triage_eval_runs_version_idx on ai_triage_eval_runs(engine_version,created_at desc);
