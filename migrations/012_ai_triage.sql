create table if not exists ai_triage_assessments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  demand_id uuid references demand_requests(id) on delete set null,
  requested_by_actor_id uuid references actors(id),
  source text not null default 'ai',
  model_provider text,
  model_name text,
  input_snapshot jsonb not null default '{}'::jsonb,
  symptom_summary text,
  suggested_capabilities jsonb not null default '[]'::jsonb,
  suggested_drivability text,
  safety_flags jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  requires_human_review boolean not null default true,
  status text not null default 'proposed' check (status in ('proposed','reviewed','accepted','rejected','superseded')),
  reviewed_by_actor_id uuid references actors(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now()
);
create index if not exists ai_triage_case_idx on ai_triage_assessments(case_id,created_at desc);

create table if not exists ai_triage_actions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references ai_triage_assessments(id) on delete cascade,
  action_type text not null,
  action_payload jsonb not null default '{}'::jsonb,
  state text not null default 'suggested' check (state in ('suggested','approved','rejected','executed')),
  approved_by_actor_id uuid references actors(id),
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ai_triage_actions_assessment_idx on ai_triage_actions(assessment_id,state);
