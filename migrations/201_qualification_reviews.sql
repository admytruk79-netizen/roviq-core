-- Preserve existing evidence; only new Ops reviews acquire reviewer provenance.
alter table actor_qualification_evidence
  add column review_version integer not null default 0,
  add column review_reason text,
  add column reviewed_by_identity_id uuid references principal_identities(id),
  add column reviewed_at timestamptz;

-- NOT VALID preserves historical records without inventing verification evidence.
-- All subsequent inserts/updates must satisfy the constraint.
alter table actor_qualification_evidence add constraint qualification_verified_source
  check(evidence_status <> 'verified' or nullif(btrim(verified_source),'') is not null) not valid;
