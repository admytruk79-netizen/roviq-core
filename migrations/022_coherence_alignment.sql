-- ROVIQ coherence alignment
-- Separates recommendation from selection, preserves origin continuity,
-- models partner subtype/context, and creates an explicit completed-coordination event.

alter table service_cases
  add column if not exists originating_actor_id uuid references actors(id),
  add column if not exists relationship_owner_actor_id uuid references actors(id),
  add column if not exists overflow_authorized boolean not null default false,
  add column if not exists return_to_origin boolean not null default true,
  add column if not exists selection_mode text not null default 'customer_choice',
  add column if not exists recommended_actor_id uuid references actors(id),
  add column if not exists selected_actor_id uuid references actors(id),
  add column if not exists selection_source text,
  add column if not exists selected_at timestamptz;

alter table service_cases drop constraint if exists service_cases_selection_mode_check;
alter table service_cases add constraint service_cases_selection_mode_check
  check (selection_mode in ('customer_choice','dealer_controlled','auto_dispatch','ops_override'));

alter table actors
  add column if not exists partner_subtype text;

alter table actors drop constraint if exists actors_partner_subtype_check;
alter table actors add constraint actors_partner_subtype_check
  check (partner_subtype is null or partner_subtype in ('dealership','independent_repair','service_center','mobile_service','diagnostic','parts_supplier','tow_valet','mobility'));

create table if not exists actor_relationships (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references domains(id) on delete cascade,
  source_actor_id uuid not null references actors(id) on delete cascade,
  target_actor_id uuid not null references actors(id) on delete cascade,
  relationship_type text not null,
  priority integer not null default 100,
  active boolean not null default true,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_actor_id,target_actor_id,relationship_type)
);
create index if not exists actor_relationships_source_idx on actor_relationships(source_actor_id,active,relationship_type);
create index if not exists actor_relationships_target_idx on actor_relationships(target_actor_id,active,relationship_type);

create table if not exists case_selections (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  recommended_actor_id uuid references actors(id),
  selected_actor_id uuid references actors(id),
  selection_mode text not null,
  authority_role text not null,
  authority_actor_id uuid references actors(id),
  routing_decision_id uuid references routing_decisions(id),
  rationale jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (selection_mode in ('customer_choice','dealer_controlled','auto_dispatch','ops_override'))
);
create index if not exists case_selections_case_idx on case_selections(case_id,created_at desc);

create table if not exists coordination_completions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references service_cases(id) on delete cascade,
  completed_at timestamptz not null default now(),
  completion_basis text not null,
  billable boolean not null default false,
  billing_basis jsonb not null default '{}'::jsonb,
  created_by_role text not null,
  created_by_actor_id uuid references actors(id),
  created_at timestamptz not null default now()
);

alter table routing_decisions
  add column if not exists recommended_actor_id uuid references actors(id),
  add column if not exists selection_mode text;

-- Existing selected_actor_id is retained for compatibility but should represent an
-- actual selection only. New routing code writes recommendation separately.
