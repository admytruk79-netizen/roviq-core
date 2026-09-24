-- ROVIQ Core migration 076
-- Durable Stripe event claim leases and database-enforced dispute-loss idempotency.

begin;

alter table payment_provider_events
  drop constraint if exists payment_provider_events_processing_state_check;

alter table payment_provider_events
  add constraint payment_provider_events_processing_state_check
  check (processing_state in ('received','processing','processed','ignored','failed'));

alter table payment_provider_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

create index if not exists idx_payment_provider_events_processing_lease
  on payment_provider_events(provider,processing_state,processing_started_at)
  where processing_state='processing';

create unique index if not exists ledger_payment_dispute_loss_unique
  on ledger_entries(payment_intent_id,external_reference)
  where entry_type='payment_dispute_loss'
    and payment_intent_id is not null
    and external_reference is not null;

commit;
