-- ROVIQ Core migration 033
-- Native Shop OS waitlist state for ROVIQ-native partners.
-- Waitlist entries are bounded shop-operating facts; they do not replace the canonical Service Case or appointment tables.

begin;

create table if not exists shop_waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  service_case_id uuid references service_cases(id) on delete set null,
  requested_service_category text,
  requested_after timestamptz,
  requested_before timestamptz,
  estimated_duration_minutes integer check (estimated_duration_minutes is null or estimated_duration_minutes > 0),
  preferred_resource_types text[] not null default '{}',
  priority integer not null default 100,
  state text not null default 'waiting' check (state in ('waiting','offered','booked','expired','cancelled')),
  offer_expires_at timestamptz,
  booked_appointment_id uuid references roviq_appointments(id) on delete set null,
  notes text,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requested_before is null or requested_after is null or requested_before > requested_after),
  check ((state='booked' and booked_appointment_id is not null) or state<>'booked')
);

create index if not exists idx_shop_waitlist_scope_state
  on shop_waitlist_entries(organization_id,location_id,state,priority,created_at);
create index if not exists idx_shop_waitlist_case
  on shop_waitlist_entries(service_case_id,state,updated_at desc);

commit;
