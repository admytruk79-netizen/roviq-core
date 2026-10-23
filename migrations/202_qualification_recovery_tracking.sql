-- Track MACRE recovery as a durable, audited work item.
create table if not exists qualification_recovery_cases (
 id uuid primary key default gen_random_uuid(),
 case_id uuid not null references service_cases(id) on delete cascade,
 actor_id uuid not null references actors(id),
 requirement_key text not null,
 state text not null default 'open' check (state in ('open','resolved')),
 resolution_type text check (resolution_type in ('verified_alternative','provider_reassigned','case_cancelled','other')),
 resolution_note text,
 evidence_reference text,
 resolved_by_identity_id uuid,
 resolved_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(case_id,actor_id,requirement_key)
);
create index if not exists idx_qualification_recovery_open on qualification_recovery_cases(case_id,state);
