-- Percentage markup on top of the dealer's listed price, in basis points
-- (850 = 8.5%). The public price is dealer price + flat margin + markup,
-- rounded to the nearest cent, and stays null when the dealer price is unknown.
alter table vehicle_inventory add column if not exists markup_bps integer not null default 850
  check (markup_bps >= 0 and markup_bps <= 10000);
alter table vehicle_inventory drop column public_price_cents;
alter table vehicle_inventory add column public_price_cents bigint
  generated always as (case when source_price_cents is null then null
    else source_price_cents + margin_cents + round(source_price_cents * markup_bps / 10000.0)::bigint end) stored;
create index if not exists vehicle_inventory_public_idx on vehicle_inventory(status,last_seen_at);
