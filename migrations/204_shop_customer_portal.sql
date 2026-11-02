-- A shop's own customer portal (Shop OS as a standalone shop system): one private link per walk-in
-- customer opens their vehicles, current and past jobs, inspection results, the shop's updates,
-- approvals and payment. Only a hash of the token is stored.

create table if not exists shop_customer_portal_links (
  id uuid primary key default gen_random_uuid(),
  shop_customer_id uuid not null references shop_customers(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  token_hash text not null unique,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_viewed_at timestamptz
);
create index if not exists idx_shop_customer_portal_links_customer on shop_customer_portal_links(shop_customer_id, created_at desc);

-- Messages the shop writes for the customer about a job ("Car is on the lift", "Part arrives tomorrow").
create table if not exists shop_customer_updates (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  message text not null check (length(btrim(message)) between 1 and 1000),
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_shop_customer_updates_order on shop_customer_updates(repair_order_id, created_at desc);
