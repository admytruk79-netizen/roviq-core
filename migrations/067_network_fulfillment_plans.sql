-- ROVIQ Core migration 061
-- Canonical distributed-network fulfillment planning.
-- Plans assemble already-authorized Core routing/serviceability output into a
-- durable case-level snapshot without creating a second workflow authority.

begin;

create table if not exists fulfillment_plans (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null references service_cases(id) on delete cascade,
  version integer not null,
  status text not null check (status in ('draft','feasible','blocked','accepted','superseded','completed','cancelled')),
  routing_decision_id uuid references routing_decisions(id) on delete set null,
  selected_actor_id uuid references actors(id) on delete set null,
  blockers jsonb not null default '[]'::jsonb,
  dependency_snapshot jsonb not null default '{}'::jsonb,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(service_case_id,version)
);

create index if not exists idx_fulfillment_plans_case
  on fulfillment_plans(service_case_id,version desc);

create table if not exists fulfillment_candidates (
  id uuid primary key default gen_random_uuid(),
  fulfillment_plan_id uuid not null references fulfillment_plans(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  rank integer not null check (rank > 0),
  score numeric,
  serviceability jsonb not null default '{}'::jsonb,
  signals jsonb not null default '{}'::jsonb,
  participant_status text not null default 'proposed'
    check (participant_status in ('proposed','accepted','declined','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(fulfillment_plan_id,actor_id),
  unique(fulfillment_plan_id,rank)
);

create index if not exists idx_fulfillment_candidates_actor
  on fulfillment_candidates(actor_id,participant_status,created_at desc);

commit;
