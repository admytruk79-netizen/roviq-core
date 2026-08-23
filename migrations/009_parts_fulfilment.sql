create table if not exists parts_inventory (
  id uuid primary key default gen_random_uuid(),
  supplier_actor_id uuid not null references actors(id) on delete cascade,
  sku text not null,
  part_number text,
  description text,
  quantity_on_hand integer not null default 0,
  quantity_reserved integer not null default 0,
  unit_price numeric(12,2),
  currency text not null default 'USD',
  location_id uuid references locations(id),
  attributes jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(supplier_actor_id, sku, location_id)
);
create index if not exists parts_inventory_supplier_idx on parts_inventory(supplier_actor_id,active,sku);

create table if not exists parts_orders (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  requested_by_actor_id uuid references actors(id),
  supplier_actor_id uuid references actors(id),
  status text not null default 'requested' check (status in ('requested','supplier_assigned','reserved','ordered','shipped','delivered','cancelled','failed')),
  delivery_location_id uuid references locations(id),
  needed_by timestamptz,
  tracking_reference text,
  external_order_reference text,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists parts_orders_case_idx on parts_orders(case_id,created_at desc);
create index if not exists parts_orders_supplier_idx on parts_orders(supplier_actor_id,status,updated_at);

create table if not exists parts_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references parts_orders(id) on delete cascade,
  inventory_id uuid references parts_inventory(id),
  sku text not null,
  part_number text,
  description text,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2),
  currency text not null default 'USD',
  status text not null default 'requested' check (status in ('requested','reserved','ordered','shipped','delivered','cancelled','failed')),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists parts_order_items_order_idx on parts_order_items(order_id,status);
