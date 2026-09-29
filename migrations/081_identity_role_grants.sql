-- One sign-in can hold several workspace roles (e.g. a shop that also tows). The role on
-- principal_identities stays the identity's primary role; each additional role is a grant bound
-- to the actor that performs it, so every role still reads and mutates only through its own actor.
-- Admin is never grantable here: it exists only as a primary role on an actor-less identity.
create table if not exists identity_role_grants (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references principal_identities(id) on delete cascade,
  role text not null check (role in ('customer','partner','diagnostic','tow','parts','fleet')),
  actor_id uuid not null references actors(id) on delete cascade,
  active boolean not null default true,
  granted_by_identity_id uuid references principal_identities(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(identity_id, role)
);
create index if not exists identity_role_grants_identity_idx on identity_role_grants(identity_id, active);
