create table if not exists vehicle_inventory (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  source_vehicle_id text not null,
  vin text,
  year integer,
  make text not null,
  model text not null,
  trim text,
  mileage integer,
  exterior_color text,
  drivetrain text,
  fuel_type text,
  body_style text,
  image_urls jsonb not null default '[]'::jsonb,
  source_price_cents bigint,
  margin_cents bigint not null default 0,
  public_price_cents bigint generated always as (coalesce(source_price_cents,0) + margin_cents) stored,
  source_dealer_name text,
  source_dealer_url text,
  source_payload jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','pending','sold','removed')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_key,source_vehicle_id)
);
create index if not exists vehicle_inventory_search_idx on vehicle_inventory(make,model,year,status);
create index if not exists vehicle_inventory_vin_idx on vehicle_inventory(vin) where vin is not null;
