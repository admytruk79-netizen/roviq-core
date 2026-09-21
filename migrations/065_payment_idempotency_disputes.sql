-- ROVIQ Core migration 065
-- Request-idempotent provider payments and provider namespace for the existing dispute model.

begin;

alter table payment_intents
  add column if not exists client_request_id text;

create unique index if not exists payment_intents_provider_request_unique
  on payment_intents(provider,client_request_id)
  where client_request_id is not null;

alter table payment_disputes
  add column if not exists provider text not null default 'manual';

update payment_disputes
set provider='manual'
where provider is null or trim(provider)='';

create unique index if not exists payment_disputes_provider_reference_unique
  on payment_disputes(provider,external_reference);

create index if not exists payment_disputes_payment_idx
  on payment_disputes(payment_intent_id,opened_at desc);

commit;
