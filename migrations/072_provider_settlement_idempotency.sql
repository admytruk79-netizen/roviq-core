-- ROVIQ Core migration 066
-- Request-idempotent provider settlement execution.

begin;

alter table settlement_payouts
  add column if not exists client_request_id text;

create unique index if not exists settlement_payouts_provider_request_unique
  on settlement_payouts(provider,client_request_id)
  where client_request_id is not null;

commit;
