-- One persisted, leased analysis job and assessment identity per stored scan.
create table if not exists obd_analysis_jobs (
  event_id uuid primary key references vehicle_health_events(id) on delete cascade,
  case_id uuid not null references service_cases(id) on delete cascade,
  assessment_id uuid not null unique default gen_random_uuid(),
  state text not null default 'pending' check(state in ('pending','processing','retry','completed_ai','completed_fallback','blocked','reviewed')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists obd_analysis_jobs_ready_idx on obd_analysis_jobs(available_at)
  where state in ('pending','retry','processing');
