-- ROVIQ Core migration 064
-- Durable payment-provider webhook ingestion for signed, idempotent settlement truth.

begin;

create table if not exists payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  processing_state text not null default 'received'
    check (processing_state in ('received','processed','ignored','failed')),
  related_payment_intent_id uuid references payment_intents(id) on delete set null,
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider,provider_event_id)
);

create index if not exists idx_payment_provider_events_received
  on payment_provider_events(provider,received_at desc);

create index if not exists idx_payment_provider_events_payment
  on payment_provider_events(related_payment_intent_id,received_at desc);

commit;
