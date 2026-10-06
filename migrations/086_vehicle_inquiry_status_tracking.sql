-- ROVIQ Core migration 086
-- vehicle_inquiries (migration 080) only ever captured a one-time "customer asked, owner was
-- emailed" record -- there was no way to trace what happened to the truck afterward, and the
-- customer had no way to check back on it. Add a guarded status lifecycle and an unguessable
-- tracking token so a customer can trace their request through to delivery without an account,
-- the same no-login booking flow the business plan describes for the core customer journey.

alter table vehicle_inquiries add column if not exists status text not null default 'new'
  check (status in ('new','contacted','reserved','financing','purchased','delivered','cancelled'));
alter table vehicle_inquiries add column if not exists tracking_token text;
alter table vehicle_inquiries add column if not exists updated_at timestamptz not null default now();
alter table vehicle_inquiries add column if not exists purchased_at timestamptz;
alter table vehicle_inquiries add column if not exists delivered_at timestamptz;
alter table vehicle_inquiries add column if not exists cancelled_at timestamptz;

-- Backfill any pre-existing rows so every inquiry has a token, old and new alike.
update vehicle_inquiries set tracking_token = encode(gen_random_bytes(24),'hex') where tracking_token is null;

create unique index if not exists vehicle_inquiries_tracking_token_idx on vehicle_inquiries(tracking_token);
create index if not exists vehicle_inquiries_status_idx on vehicle_inquiries(status, created_at desc);
