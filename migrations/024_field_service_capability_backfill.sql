-- Migration 020 was edited twice after its first production application (see the
-- acceptedHistoricalChecksums note in src/db/migrate.ts for the matching checksum fix,
-- and migration 022 for the same pattern applied to 017): the migration runner only ever
-- executes a numbered file's SQL once, on first application, so everything added to 020
-- after production's first deploy of it -- the diagnostic_findings disposition constraint
-- update and the entire field_service_actor_capabilities table -- never actually ran
-- against the production database, even though the current 020 file assumes both exist.
-- Re-apply both here, idempotently, as their own migration so every environment (however
-- far along it got on 020) converges on the same schema.

alter table diagnostic_findings drop constraint if exists diagnostic_findings_disposition_check;
alter table diagnostic_findings add constraint diagnostic_findings_disposition_check
  check (disposition in ('diagnose_only','diagnose_and_fix','field_service_assessment','route_to_shop','route_to_tow'));

create table if not exists field_service_actor_capabilities (
  actor_id uuid primary key references actors(id) on delete cascade,
  active boolean not null default true,
  repair_classes jsonb not null default '[]'::jsonb,
  capabilities jsonb not null default '[]'::jsonb,
  tools jsonb not null default '[]'::jsonb,
  max_estimated_minutes integer,
  max_estimated_cost numeric(12,2),
  verified_by_actor_id uuid references actors(id) on delete set null,
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table field_service_actor_capabilities is 'Admin-verified repair classes, capabilities and tools for actors permitted to perform field work.';
