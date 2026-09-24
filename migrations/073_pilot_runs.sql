-- ROVIQ Core migration 067
-- Controlled pilot execution record and evidence trail.

begin;

create table if not exists pilot_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  location_id uuid not null references locations(id) on delete restrict,
  status text not null default 'planned'
    check (status in ('planned','ready','active','completed','aborted')),
  readiness_snapshot jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_by_actor_id uuid references actors(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  aborted_at timestamptz,
  abort_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pilot_runs_location_open_unique
  on pilot_runs(location_id)
  where status in ('ready','active');

create index if not exists pilot_runs_scope_idx
  on pilot_runs(organization_id,location_id,created_at desc);

commit;
