-- Dispatcher-to-actor assignment offer lifecycle for universal Core Cases.
create table if not exists core_assignment_offers (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references core_cases(id) on delete cascade,
  offered_to_actor_id uuid not null references actors(id),
  offered_by_actor_id uuid references actors(id),
  previous_owner_actor_id uuid references actors(id),
  state text not null default 'pending' check(state in ('pending','accepted','declined','expired','cancelled','stale')),
  expected_case_version bigint not null check(expected_case_version > 0),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_core_assignment_offer_pending_case
  on core_assignment_offers(case_id) where state='pending';
create index if not exists core_assignment_offer_actor_idx
  on core_assignment_offers(offered_to_actor_id,state,created_at desc);
create index if not exists core_assignment_offer_case_idx
  on core_assignment_offers(case_id,created_at desc);
