-- ROVIQ Core migration 065
-- Idempotent outbound provider payments plus canonical dispute tracking.

begin;

alter table payment_intents
  add column if not exists client_request_id text;

create unique index if not exists payment_intents_provider_request_unique
  on payment_intents(provider,client_request_id)
  where client_request_id is not null;

create table if not exists payment_disputes (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null references payment_intents(id) on delete cascade,
  provider text not null,
  provider_dispute_id text not null,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null,
  reason text,
  state text not null check (state in ('needs_response','under_review','won','lost','warning_closed')),
  evidence_due_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(provider,provider_dispute_id)
);

create index if not exists idx_payment_disputes_payment
  on payment_disputes(payment_intent_id,updated_at desc);

commit;
