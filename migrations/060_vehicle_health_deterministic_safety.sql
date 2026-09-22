-- ROVIQ Core migration 060
-- Deterministic safety override columns on vehicle_health_events, mirroring the
-- safety_override/safety_override_reason pattern already used on ai_triage_assessments
-- (migration 013): a source's self-reported severity/safety_state is evidence, not authority.

begin;

alter table vehicle_health_events add column if not exists requires_human_review boolean not null default false;
alter table vehicle_health_events add column if not exists safety_override boolean not null default false;
alter table vehicle_health_events add column if not exists safety_override_reason text;
create index if not exists idx_vehicle_health_review_required on vehicle_health_events(requires_human_review) where requires_human_review;

commit;
