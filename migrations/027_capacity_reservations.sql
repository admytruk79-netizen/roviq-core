-- Canonical capacity reservations serialize point-of-commit provider selection.
-- Routing may observe capacity optimistically; selection must reserve a concrete window
-- in the same transaction before a provider can be committed.

begin;

create table if not exists capacity_reservations (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null references service_cases(id) on delete cascade,
  capacity_window_id uuid not null references capacity_windows(id) on delete cascade,
  units integer not null default 1 check (units > 0),
  state text not null default 'held' check (state in ('held','consumed','released','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  consumed_at timestamptz
);

create index if not exists idx_capacity_reservations_window_active
  on capacity_reservations(capacity_window_id,expires_at)
  where state='held';

create index if not exists idx_capacity_reservations_case
  on capacity_reservations(service_case_id,state,updated_at desc);

create unique index if not exists idx_capacity_reservations_case_window_active
  on capacity_reservations(service_case_id,capacity_window_id)
  where state='held';

commit;
