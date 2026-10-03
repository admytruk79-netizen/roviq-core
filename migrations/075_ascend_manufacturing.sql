begin;

create table if not exists manufacturing_jobs (
 id uuid primary key default gen_random_uuid(),
 external_job_id text not null unique,
 domain text not null check(domain='apparel-manufacturing'),
 design_ref text not null,
 package_id text not null,
 package_sha256 text not null check(package_sha256 ~ '^[0-9a-fA-F]{64}$'),
 manufacturer_actor_id uuid references actors(id) on delete restrict,
 capability_profile_version text not null,
 status text not null check(status in ('package-generated','manufacturer-accepted','in-production','qc-passed','shipped','delivered')),
 version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists manufacturing_jobs_manufacturer_status_idx on manufacturing_jobs(manufacturer_actor_id,status,updated_at desc);

create table if not exists manufacturing_events (
 id uuid primary key default gen_random_uuid(),
 manufacturing_job_id uuid not null references manufacturing_jobs(id) on delete restrict,
 event_type text not null,
 actor_id uuid references actors(id) on delete set null,
 idempotency_key text not null,
 correlation_id uuid not null default gen_random_uuid(),
 payload jsonb not null default '{}'::jsonb,
 previous_version integer not null,
 new_version integer not null,
 occurred_at timestamptz not null default now(),
 unique(manufacturing_job_id,idempotency_key),
 unique(manufacturing_job_id,new_version),
 check(new_version=previous_version+1)
);
create index if not exists manufacturing_events_job_time_idx on manufacturing_events(manufacturing_job_id,occurred_at,id);

create table if not exists manufacturing_outbox (
 id uuid primary key default gen_random_uuid(),
 manufacturing_event_id uuid not null unique references manufacturing_events(id) on delete restrict,
 topic text not null,
 payload jsonb not null,
 created_at timestamptz not null default now(),
 published_at timestamptz,
 attempts integer not null default 0 check(attempts>=0),
 last_error text
);
create index if not exists manufacturing_outbox_pending_idx on manufacturing_outbox(created_at) where published_at is null;

commit;
