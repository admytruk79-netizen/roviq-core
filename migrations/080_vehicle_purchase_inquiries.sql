-- ROVIQ Core migration 080
-- A customer looking at live dealer inventory needs a way to book/reserve a specific car and
-- then trace it through to delivery -- reusing Core's existing generic events/audit primitives
-- (the same ones every other domain in this system uses) rather than a bespoke tracking table.
-- No account/login is required to create one, matching the zero-friction customer booking flow
-- described in the business plan; a customer is identified by contact info plus an unguessable
-- tracking token, and optionally linked to a real actor if they are already a ROVIQ customer.

create table if not exists vehicle_purchase_inquiries (
  id uuid primary key default gen_random_uuid(),
  vehicle_inventory_id uuid not null references vehicle_inventory(id),
  customer_actor_id uuid references actors(id),
  contact_name text not null,
  contact_email text,
  contact_phone text,
  status text not null default 'inquired' check (status in (
    'inquired','contacted','reserved','financing','purchased','delivered','cancelled'
  )),
  -- Snapshot of the public (dealer price + margin + markup) price at booking time, so a later
  -- live-inventory price change never retroactively changes what the customer was shown.
  offer_price_cents bigint not null check (offer_price_cents >= 0),
  currency char(3) not null default 'USD',
  tracking_token text not null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  purchased_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  check (contact_email is not null or contact_phone is not null)
);
create unique index if not exists vehicle_purchase_inquiries_tracking_idx on vehicle_purchase_inquiries(tracking_token);
create index if not exists vehicle_purchase_inquiries_vehicle_idx on vehicle_purchase_inquiries(vehicle_inventory_id, created_at desc);
create index if not exists vehicle_purchase_inquiries_status_idx on vehicle_purchase_inquiries(status, created_at desc);
create index if not exists vehicle_purchase_inquiries_customer_idx on vehicle_purchase_inquiries(customer_actor_id) where customer_actor_id is not null;
