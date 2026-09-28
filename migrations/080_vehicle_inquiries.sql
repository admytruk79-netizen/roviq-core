-- Customer requests for a specific inventory truck, tied to its VIN and the
-- dealer that listed it when the request arrived (admin-only information).
create table if not exists vehicle_inquiries (
  id uuid primary key default gen_random_uuid(),
  vin text not null,
  vehicle_inventory_id uuid references vehicle_inventory(id) on delete set null,
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  note text,
  available_at_request boolean not null,
  quoted_price_cents bigint,
  source_price_cents bigint,
  dealer_name text,
  dealer_url text,
  vehicle_title text,
  client_ip text,
  owner_notified boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists vehicle_inquiries_vin_idx on vehicle_inquiries(vin);
create index if not exists vehicle_inquiries_ip_idx on vehicle_inquiries(client_ip,created_at);
