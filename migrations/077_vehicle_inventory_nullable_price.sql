-- Preserve the checksum of 060 for databases where the inventory schema was
-- already applied. An unknown dealer price must not display as the margin.
alter table vehicle_inventory drop column public_price_cents;
alter table vehicle_inventory add column public_price_cents bigint
  generated always as (case when source_price_cents is null then null
    else source_price_cents + margin_cents end) stored;
