-- Signing secrets Core obtains from a provider itself (for example the Stripe webhook secret,
-- which Stripe returns only once, when Core registers its webhook). Never returned by any endpoint.
create table if not exists integration_secrets (
  name text primary key,
  value text not null,
  reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
