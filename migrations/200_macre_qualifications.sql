-- MACRE qualification requirements and verified evidence, opt-in per service case.
-- No existing case is blocked until its requirements are explicitly registered.
create table if not exists case_qualification_requirements (
 id uuid primary key default gen_random_uuid(),
 service_case_id uuid not null references service_cases(id) on delete cascade,
 requirement_key text not null,
 kind text not null check(kind in ('legal_license','oem_certification','manufacturer_access','training','equipment','facility','parts','capacity','authorization')),
 scope text,
 mandatory boolean not null default true,
 created_at timestamptz not null default now(),
 unique(service_case_id,requirement_key)
);
create index if not exists idx_case_qualification_requirements_case on case_qualification_requirements(service_case_id);
create table if not exists actor_qualification_evidence (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references actors(id) on delete cascade,
 requirement_key text not null,
 kind text not null check(kind in ('legal_license','oem_certification','manufacturer_access','training','equipment','facility','parts','capacity','authorization')),
 scope text,
 evidence_status text not null default 'unverified' check(evidence_status in ('verified','unverified','expired','revoked')),
 verified_source text,
 verified_by text,
 valid_until timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists idx_actor_qualification_evidence_lookup on actor_qualification_evidence(actor_id,requirement_key);
comment on table actor_qualification_evidence is 'Internal verified evidence only. Do not expose through public actor APIs.';
