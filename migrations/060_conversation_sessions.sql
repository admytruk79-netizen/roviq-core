-- ROVIQ Core migration 060
-- Shared conversation sessions for the adaptive multi-actor front end.
-- Sessions reference the existing identity/actor/case/vehicle model; they do not create a parallel actor system.

begin;

create table if not exists conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  principal_identity_id uuid,
  actor_id uuid references actors(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  active_role text not null,
  workspace text not null default 'drive',
  vehicle_id uuid references customer_vehicles(id) on delete set null,
  service_case_id uuid references service_cases(id) on delete set null,
  journey_context jsonb not null default '{}'::jsonb,
  last_intent text,
  last_entities jsonb not null default '{}'::jsonb,
  last_result_refs jsonb not null default '[]'::jsonb,
  presentation_source text not null default 'phone'
    check (presentation_source in ('phone','android_auto','web','dispatcher','shop','tow','fleet','diagnostic','parts','admin')),
  state text not null default 'active' check (state in ('active','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (actor_id is not null or active_role='admin')
);

create index if not exists idx_conversation_sessions_actor_active
  on conversation_sessions(actor_id,state,last_message_at desc);
create index if not exists idx_conversation_sessions_identity_active
  on conversation_sessions(principal_identity_id,state,last_message_at desc);
create index if not exists idx_conversation_sessions_case
  on conversation_sessions(service_case_id,state,last_message_at desc);

create table if not exists conversation_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references conversation_sessions(id) on delete cascade,
  direction text not null check (direction in ('user','assistant','tool')),
  intent text,
  content text,
  tool_name text,
  tool_result_ref jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_conversation_turns_session
  on conversation_turns(session_id,created_at desc);

commit;
