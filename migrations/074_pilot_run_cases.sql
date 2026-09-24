-- ROVIQ Core migration 068
-- Explicit service-case membership for controlled pilot evidence.

begin;

create table if not exists pilot_run_cases (
  pilot_run_id uuid not null references pilot_runs(id) on delete cascade,
  service_case_id uuid not null references service_cases(id) on delete restrict,
  added_by_actor_id uuid references actors(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key(pilot_run_id,service_case_id)
);

create index if not exists pilot_run_cases_case_idx
  on pilot_run_cases(service_case_id,pilot_run_id);

commit;
