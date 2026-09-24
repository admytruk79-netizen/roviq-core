-- ROVIQ Core migration 062
-- Participant acceptance and cross-domain network handoff trace for distributed fulfillment.

begin;

create table if not exists participant_acceptances (
  id uuid primary key default gen_random_uuid(),
  fulfillment_plan_id uuid not null references fulfillment_plans(id) on delete cascade,
  fulfillment_candidate_id uuid references fulfillment_candidates(id) on delete set null,
  service_case_id uuid not null references service_cases(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  decision text not null check (decision in ('accepted','declined')),
  source_type text not null,
  source_reference_id text,
  metadata jsonb not null default '{}'::jsonb,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(fulfillment_plan_id,actor_id)
);

create index if not exists idx_participant_acceptances_case
  on participant_acceptances(service_case_id,decided_at desc);

create table if not exists network_handoffs (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null references service_cases(id) on delete cascade,
  fulfillment_plan_id uuid references fulfillment_plans(id) on delete set null,
  handoff_type text not null check (handoff_type in ('service_provider','parts','transport','mobility','diagnostic','other')),
  participant_actor_id uuid references actors(id) on delete set null,
  reference_type text not null,
  reference_id text not null,
  status text not null check (status in ('planned','assigned','accepted','in_progress','completed','declined','failed','cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(service_case_id,handoff_type,reference_type,reference_id)
);

create index if not exists idx_network_handoffs_case
  on network_handoffs(service_case_id,created_at asc);

commit;
