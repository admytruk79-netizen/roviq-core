create table if not exists principal_identities (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references actors(id) on delete cascade,
  email text unique not null,
  role text not null check (role in ('admin','customer','partner','diagnostic','tow','parts','fleet')),
  password_salt text not null,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((role='admin' and actor_id is null) or (role<>'admin' and actor_id is not null))
);
create index if not exists principal_identities_actor_idx on principal_identities(actor_id,active);
