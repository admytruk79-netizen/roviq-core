-- ROVIQ Platform Master Technical Specification v2.0
-- Shared identity, organization, geography and role-scope foundation.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  email text unique,
  phone text unique,
  auth_provider text not null default 'local',
  status text not null default 'active' check (status in ('active','suspended','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  role_key text not null,
  domain text,
  description text,
  unique(role_key, domain)
);

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  organization_type text not null,
  legal_name text,
  display_name text not null,
  status text not null default 'active',
  contact_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists markets (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  country_code text not null,
  region text,
  city text,
  timezone text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  market_id uuid references markets(id) on delete set null,
  name text,
  address text,
  latitude double precision,
  longitude double precision,
  country_code text,
  region text,
  city text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180)
);
create index if not exists locations_market_idx on locations(market_id);
create index if not exists locations_org_idx on locations(organization_id);

create table if not exists organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  primary key(organization_id,user_id,role)
);

create table if not exists user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  scope_type text not null default 'global' check (scope_type in ('global','domain','region','market','organization','self')),
  scope_id text,
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists user_role_scope_idx on user_role_assignments(user_id,scope_type,scope_id) where revoked_at is null;

-- Operational actors remain domain-facing identities, but can now reference the canonical platform model.
alter table actors add column if not exists organization_id uuid references organizations(id) on delete set null;
alter table actors add column if not exists location_id uuid references locations(id) on delete set null;
alter table actors add column if not exists user_id uuid references users(id) on delete set null;
create index if not exists actors_org_idx on actors(organization_id,status);
create index if not exists actors_location_idx on actors(location_id,status);

insert into roles(role_key,domain,description) values
  ('SUPER_ADMIN',null,'Global ROVIQ visibility and override'),
  ('DOMAIN_ADMIN','maintenance','Maintenance domain administration'),
  ('DOMAIN_ADMIN','local','ROVIQ Local domain administration'),
  ('DOMAIN_ADMIN','station','ROVIQ Station domain administration'),
  ('REGIONAL_ADMIN',null,'Country/region/multi-market administration'),
  ('CITY_CURATOR','local','ROVIQ Local market curation'),
  ('PARTNER_ADMIN',null,'Organization-scoped partner administration'),
  ('CONTRIBUTOR','local','Own submissions and reputation'),
  ('PUBLIC_USER',null,'Public product surfaces')
on conflict(role_key,domain) do nothing;
