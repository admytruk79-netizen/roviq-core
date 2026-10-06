-- The original global external_reference constraint conflicts with the
-- provider-scoped uniqueness added in migration 071. Keep the provider key
-- as the canonical idempotency boundary for dispute references.
begin;

alter table payment_disputes
  drop constraint if exists payment_disputes_external_reference_key;

commit;
