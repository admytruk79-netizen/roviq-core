-- Open job board: a case published for nearby technicians to claim, Uber-style. Each job carries a
-- rank (premium / standard / basic) worked out from the vehicle, urgency and work; better-ranked
-- technicians see better jobs first. At most one live listing per case.
create table if not exists open_jobs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  demand_id uuid not null references demand_requests(id),
  capability text not null default 'diagnostics' check (capability in ('diagnostics')),
  job_rank text not null check (job_rank in ('premium','standard','basic')),
  job_score integer not null,
  rank_reasons jsonb not null default '[]'::jsonb,
  urgency text not null default 'normal' check (urgency in ('normal','urgent','emergency')),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  state text not null default 'open' check (state in ('open','claimed','withdrawn')),
  published_by_role text,
  published_by_actor_id uuid references actors(id) on delete set null,
  published_at timestamptz not null default now(),
  claimed_by_actor_id uuid references actors(id) on delete set null,
  claimed_at timestamptz,
  offer_id uuid references matches_offers(id) on delete set null,
  withdrawn_at timestamptz,
  withdrawn_reason text
);
create unique index if not exists open_jobs_one_live_per_case on open_jobs(case_id) where state = 'open';
create index if not exists open_jobs_open_idx on open_jobs(published_at) where state = 'open';

-- Customers rate the provider who served them, once per case and provider. Feeds the technician
-- ranking (and routing's existing rating signal).
create table if not exists provider_ratings (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  customer_actor_id uuid references actors(id) on delete set null,
  stars smallint not null check (stars between 1 and 5),
  comment text check (comment is null or length(comment) <= 1000),
  created_at timestamptz not null default now(),
  unique (case_id, actor_id)
);
create index if not exists provider_ratings_actor_idx on provider_ratings(actor_id);
