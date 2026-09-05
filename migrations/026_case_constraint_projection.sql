-- ROVIQ Core migration 026
-- Make case_constraints the canonical projection consumed by serviceability.
-- Source operating tables remain authoritative; this table stores their current
-- serviceability effect without creating parallel workflow state.

begin;

alter table case_constraints add column if not exists source_type text not null default 'manual';
alter table case_constraints add column if not exists projection_key text;
alter table case_constraints add column if not exists source_updated_at timestamptz;

create unique index if not exists idx_case_constraints_projection
  on case_constraints(service_case_id,projection_key)
  where projection_key is not null;

create index if not exists idx_case_constraints_source
  on case_constraints(source_type,updated_at desc);

-- Reassert the canonical lifecycle transitions used by all role projections.
-- These statements are idempotent and do not rewrite in-flight case state.
insert into case_transition_rules(from_state,to_state,allowed_roles,terminal) values
('intake','triage',array['customer','admin'],false),
('triage','diagnostic_pending',array['admin'],false),
('triage','provider_selection',array['admin'],false),
('triage','tow_pending',array['admin'],false),
('diagnostic_pending','diagnostic_in_progress',array['diagnostic','admin'],false),
('diagnostic_in_progress','provider_selection',array['diagnostic','admin'],false),
('diagnostic_in_progress','tow_pending',array['diagnostic','admin'],false),
('diagnostic_in_progress','repair_in_progress',array['diagnostic','admin'],false),
('tow_pending','tow_in_progress',array['tow','admin'],false),
('tow_in_progress','provider_selection',array['tow','admin'],false),
('provider_selection','provider_pending',array['customer','partner','admin'],false),
('provider_pending','repair_in_progress',array['partner','admin'],false),
('provider_pending','provider_selection',array['partner','admin'],false),
('repair_in_progress','parts_pending',array['partner','admin'],false),
('parts_pending','repair_in_progress',array['parts','partner','admin'],false),
('repair_in_progress','payment_pending',array['partner','admin'],false),
('payment_pending','completed',array['admin'],true)
on conflict(from_state,to_state) do update
set allowed_roles=excluded.allowed_roles,
    terminal=excluded.terminal;

commit;
