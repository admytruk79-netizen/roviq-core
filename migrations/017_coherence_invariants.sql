-- ROVIQ coherence invariants: one case, governed selection, continuity and spatial context.

alter table service_cases
  add column if not exists originating_actor_id uuid references actors(id),
  add column if not exists relationship_owner_actor_id uuid references actors(id),
  add column if not exists selection_mode text not null default 'customer_choice',
  add column if not exists selected_actor_id uuid references actors(id),
  add column if not exists selected_by_role text,
  add column if not exists selected_at timestamptz,
  add column if not exists coordination_completed_at timestamptz,
  add column if not exists coordination_completion_code text;

alter table service_cases drop constraint if exists service_cases_selection_mode_check;
alter table service_cases add constraint service_cases_selection_mode_check
  check (selection_mode in ('customer_choice','dealer_controlled','auto_dispatch','ops_override'));

create index if not exists service_cases_origin_idx on service_cases(originating_actor_id,created_at desc);
create index if not exists service_cases_relationship_owner_idx on service_cases(relationship_owner_actor_id,state);

alter table actors add column if not exists partner_subtype text;
alter table actors drop constraint if exists actors_partner_subtype_check;
alter table actors add constraint actors_partner_subtype_check check (
  partner_subtype is null or partner_subtype in ('dealership','independent_repair','service_center','mobile_service')
);

alter table routing_decisions
  add column if not exists recommended_actor_id uuid references actors(id),
  add column if not exists selection_mode text;

alter table routing_decisions drop constraint if exists routing_decisions_selection_mode_check;
alter table routing_decisions add constraint routing_decisions_selection_mode_check check (
  selection_mode is null or selection_mode in ('customer_choice','dealer_controlled','auto_dispatch','ops_override')
);

create table if not exists case_spatial_context (
  case_id uuid primary key references service_cases(id) on delete cascade,
  origin jsonb,
  current_vehicle jsonb,
  destination jsonb,
  diagnostic_location jsonb,
  provider_location jsonb,
  transport_location jsonb,
  parts_origin jsonb,
  route_context jsonb not null default '{}'::jsonb,
  source text not null default 'core',
  updated_at timestamptz not null default now()
);

create table if not exists coordination_milestones (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  milestone_code text not null,
  billable boolean not null default false,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(case_id,milestone_code)
);
create index if not exists coordination_milestones_case_idx on coordination_milestones(case_id,occurred_at);
