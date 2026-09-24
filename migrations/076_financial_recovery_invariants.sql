-- ROVIQ Core migration 076
-- Financial recovery invariants for Stripe webhook claims and dispute-loss idempotency.

begin;

alter table payment_provider_events
  add column if not exists claimed_at timestamptz;

alter table payment_provider_events
  drop constraint if exists payment_provider_events_processing_state_check;

alter table payment_provider_events
  add constraint payment_provider_events_processing_state_check
  check (processing_state in ('received','processing','processed','ignored','failed'));

create index if not exists idx_payment_provider_events_processing
  on payment_provider_events(provider,processing_state,claimed_at,received_at);

create unique index if not exists idx_ledger_dispute_loss_unique
  on ledger_entries(payment_intent_id,entry_type,external_reference)
  where payment_intent_id is not null
    and entry_type='payment_dispute_loss'
    and external_reference is not null;

commit;
