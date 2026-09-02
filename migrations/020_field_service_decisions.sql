create table if not exists field_service_decisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  demand_id uuid references demand_requests(id) on delete set null,
  diagnostic_finding_id uuid references diagnostic_findings(id) on delete set null,
  created_by_actor_id uuid references actors(id) on delete set null,
  authorized_by_actor_id uuid references actors(id) on delete set null,
  action text not null check (action in ('field_repair','temporary_stabilization','dispatch_field_technician','route_to_shop','tow_required','remote_review')),
  status text not null default 'proposed' check (status in ('proposed','authorization_required','authorized','in_progress','completed','declined','escalated','cancelled')),
  repair_class text not null default 'unknown',
  drivability text check (drivability in ('drivable','limited','non_drivable','unknown')),
  confidence numeric(4,3),
  summary text not null,
  safety_flags jsonb not null default '{}'::jsonb,
  required_capabilities jsonb not null default '[]'::jsonb,
  required_tools jsonb not null default '[]'::jsonb,
  required_parts jsonb not null default '[]'::jsonb,
  operator_context jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  estimated_minutes integer,
  estimated_cost numeric(12,2),
  customer_authorization_required boolean not null default true,
  customer_authorized_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  outcome text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_field_service_decisions_case on field_service_decisions(case_id, created_at desc);
create index if not exists idx_field_service_decisions_status on field_service_decisions(status, updated_at desc);

comment on table field_service_decisions is 'Core-owned decision and authorization record for roadside/on-site repair, stabilization, escalation, shop routing, or tow.';
