-- Native TradeCase projection on the universal Core Case model.
create table if not exists trade_cases (
  case_id uuid primary key references core_cases(id) on delete cascade,
  trade_mode text not null check(trade_mode in ('export','import')),
  commodity_type text not null default 'vehicle',
  origin_country text not null,
  destination_country text not null,
  origin_location text,
  destination_location text,
  phase text not null default 'sourcing' check(phase in (
    'sourcing','verification','commercial_quote','approval','compliance_documents',
    'freight_booking','in_transit','destination_handoff','completed','cancelled'
  )),
  subject jsonb not null default '{}'::jsonb,
  commercial jsonb not null default '{}'::jsonb,
  compliance jsonb not null default '{}'::jsonb,
  logistics jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trade_cases_phase_idx on trade_cases(phase,updated_at desc);

create table if not exists trade_case_milestones (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references trade_cases(case_id) on delete cascade,
  milestone_code text not null,
  state text not null default 'pending' check(state in ('pending','ready','completed','blocked','waived')),
  evidence jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(case_id,milestone_code)
);

create table if not exists trade_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references trade_cases(case_id) on delete cascade,
  document_type text not null,
  status text not null default 'requested' check(status in ('requested','received','verified','rejected','expired')),
  external_reference text,
  metadata jsonb not null default '{}'::jsonb,
  verified_by_actor_id uuid references actors(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trade_documents_case_idx on trade_documents(case_id,document_type,status);
