-- Every admin identity has actor_id = NULL by design (see 003_identity.sql's
-- check constraint), so audit_log/events could never say WHICH admin
-- performed an action. These columns carry the JWT's identity id instead,
-- with no foreign key: some issued tokens (admin test-session helpers) carry
-- a synthetic, non-uuid subject, and application code only ever populates
-- this column with a validated uuid, so a strict FK would add no real
-- integrity guarantee over what the app already checks.
alter table audit_log add column if not exists principal_identity_id uuid;
alter table events add column if not exists principal_identity_id uuid;
