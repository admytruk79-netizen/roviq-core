-- ROVIQ Core migration 050
-- Financial provider references must be replay-safe. Payment intents and payment
-- events already have provider uniqueness; extend the same invariant to payouts.

begin;

create unique index if not exists settlement_payouts_provider_ref_idx
  on settlement_payouts(provider,provider_payout_id)
  where provider_payout_id is not null;

commit;
