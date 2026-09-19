-- ROVIQ Core migration 063
-- Close the distributed fulfillment lifecycle with explicit recovery state and completion outcomes.

begin;

alter table fulfillment_plans
  add column if not exists recovery_required_at timestamptz,
  add column if not exists recovery_reason text;

create table if not exists completion_outcomes (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null unique references service_cases(id) on delete cascade,
  fulfillment_plan_id uuid references fulfillment_plans(id) on delete set null,
  outcome text not null check (outcome in ('completed','partial','failed','cancelled')),
  dependency_snapshot jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  completed_by_actor_id uuid references actors(id) on delete set null,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_completion_outcomes_plan
  on completion_outcomes(fulfillment_plan_id,completed_at desc);

commit;
