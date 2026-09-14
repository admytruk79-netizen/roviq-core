create unique index if not exists settlement_payouts_provider_ref_uidx
  on settlement_payouts(provider,provider_payout_id)
  where provider_payout_id is not null;
