-- Walk-in customers of a Shop OS shop can approve an estimate and pay from a private link, and the
-- shop can record payments taken at the counter. The link token is never stored, only its hash.

create table if not exists shop_customer_links (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  token_hash text not null unique,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  decided_at timestamptz
);
create index if not exists idx_shop_customer_links_order on shop_customer_links(repair_order_id, created_at desc);

create table if not exists shop_payments (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'USD',
  method text not null check (method in ('card_online','card_terminal','cash','other')),
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  provider text,
  provider_session_id text unique,
  provider_payment_intent_id text,
  note text check (note is null or length(note) <= 500),
  recorded_by_actor_id uuid references actors(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_shop_payments_order on shop_payments(repair_order_id);
create index if not exists idx_shop_payments_org_paid on shop_payments(organization_id, paid_at) where status = 'paid';

-- Walk-in repair orders track parts readiness too; a requirement belongs to a ROVIQ case, a repair
-- order, or both.
alter table case_parts_requirements alter column service_case_id drop not null;
alter table case_parts_requirements drop constraint if exists case_parts_requirements_owner_check;
alter table case_parts_requirements add constraint case_parts_requirements_owner_check
  check (service_case_id is not null or repair_order_id is not null);
