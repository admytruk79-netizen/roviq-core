-- ROVIQ Core migration 035
-- Shop OS digital vehicle inspection, line-level WIP, and technician time.
-- Repair orders remain the fixed-operations aggregate; events remain the canonical audit stream.

begin;

create table if not exists shop_dvi_inspections (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  technician_actor_id uuid references actors(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','in_progress','submitted','void')),
  inspection_type text not null default 'general',
  summary text,
  started_at timestamptz,
  submitted_at timestamptz,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_shop_dvi_inspections_order on shop_dvi_inspections(repair_order_id,created_at,id);
create index if not exists idx_shop_dvi_inspections_shop_status on shop_dvi_inspections(organization_id,location_id,status,updated_at desc);

create table if not exists shop_dvi_findings (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references shop_dvi_inspections(id) on delete cascade,
  repair_order_line_id uuid references shop_repair_order_lines(id) on delete set null,
  section text not null,
  item text not null,
  severity text not null check (severity in ('good','attention','urgent','not_inspected')),
  measurement text,
  technician_note text,
  customer_note text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_shop_dvi_findings_inspection on shop_dvi_findings(inspection_id,sort_order,id);
create index if not exists idx_shop_dvi_findings_severity on shop_dvi_findings(inspection_id,severity);

create table if not exists shop_dvi_evidence (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references shop_dvi_inspections(id) on delete cascade,
  finding_id uuid references shop_dvi_findings(id) on delete cascade,
  media_type text not null check (media_type in ('photo','video','document')),
  storage_key text not null,
  mime_type text,
  caption text,
  customer_visible boolean not null default true,
  captured_by_actor_id uuid references actors(id) on delete set null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_shop_dvi_evidence_inspection on shop_dvi_evidence(inspection_id,created_at,id);
create index if not exists idx_shop_dvi_evidence_finding on shop_dvi_evidence(finding_id) where finding_id is not null;

create table if not exists shop_work_items (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  repair_order_line_id uuid references shop_repair_order_lines(id) on delete set null,
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  technician_actor_id uuid references actors(id) on delete set null,
  technician_resource_id uuid references service_resources(id) on delete set null,
  bay_resource_id uuid references service_resources(id) on delete set null,
  status text not null default 'queued' check (status in (
    'queued','assigned','in_progress','paused','waiting_parts','waiting_customer','quality_control','completed','cancelled'
  )),
  title text not null,
  description text,
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  blocked_reason text,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_shop_work_items_order on shop_work_items(repair_order_id,status,updated_at desc);
create index if not exists idx_shop_work_items_technician on shop_work_items(technician_actor_id,status,updated_at desc) where technician_actor_id is not null;
create unique index if not exists idx_shop_work_items_line_unique on shop_work_items(repair_order_line_id) where repair_order_line_id is not null and status <> 'cancelled';

create table if not exists shop_technician_time_entries (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references shop_work_items(id) on delete cascade,
  repair_order_id uuid not null references shop_repair_orders(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  technician_actor_id uuid not null references actors(id) on delete restrict,
  technician_resource_id uuid references service_resources(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason is null or end_reason in ('pause','complete','switch','manual')),
  notes text,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists idx_shop_technician_time_order on shop_technician_time_entries(repair_order_id,started_at,id);
create index if not exists idx_shop_technician_time_work_item on shop_technician_time_entries(work_item_id,started_at,id);
create unique index if not exists idx_shop_technician_one_open_clock
  on shop_technician_time_entries(technician_actor_id) where ended_at is null;

commit;
