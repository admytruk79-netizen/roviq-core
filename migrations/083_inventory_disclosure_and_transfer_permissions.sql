-- Network orchestration: a dealership's parts and capacity are its own. ROVIQ must never assume
-- cross-dealer inventory access or transfer rights (Master Technical Specification v2.3,
-- "Parts as First-Class Capacity"). Two objects from the spec make every exposure explicit:
--
--   inventory_disclosure_policies  (InventoryDisclosurePolicy) -- who may SEE a resource and how much
--   transfer_permissions           (TransferPermission)        -- who may REQUEST it be transferred
--
-- No row means private and non-transferable. Dedicated parts suppliers (actor_type 'parts') sell to
-- the network by nature and are not governed here; dealership and shop stock is.

create table if not exists inventory_disclosure_policies (
  id uuid primary key default gen_random_uuid(),
  owner_actor_id uuid not null references actors(id) on delete cascade,
  resource_type text not null check (resource_type in ('parts','service_capacity','mobility')),
  -- private: owner only. same_organization: the owner's dealer group / organization.
  -- named_partners: only actors holding a transfer_permissions row with can_view.
  -- network: any active network participant.
  visibility text not null default 'private' check (visibility in ('private','same_organization','named_partners','network')),
  -- availability_only discloses "in stock / not in stock"; quantity also discloses how many.
  detail text not null default 'availability_only' check (detail in ('availability_only','quantity')),
  updated_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_actor_id, resource_type)
);

create table if not exists transfer_permissions (
  id uuid primary key default gen_random_uuid(),
  grantor_actor_id uuid not null references actors(id) on delete cascade,
  grantee_actor_id uuid not null references actors(id) on delete cascade,
  resource_type text not null check (resource_type in ('parts','service_capacity','mobility')),
  can_view boolean not null default true,
  can_request_transfer boolean not null default false,
  -- A transfer request still needs the grantor's acceptance unless this is false.
  requires_acceptance boolean not null default true,
  terms jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  expires_at timestamptz,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (grantor_actor_id <> grantee_actor_id),
  unique(grantor_actor_id, grantee_actor_id, resource_type)
);
create index if not exists transfer_permissions_grantee_idx
  on transfer_permissions(grantee_actor_id, resource_type) where active;
