create table if not exists notification_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  channel text not null,
  subject_template text,
  body_template text not null,
  active boolean not null default true,
  version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(template_key,channel,version)
);
create index if not exists notification_templates_active_idx on notification_templates(template_key,channel,active,version desc);

create table if not exists notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notification_outbox(id) on delete cascade,
  attempt_number integer not null,
  provider text not null,
  provider_message_id text,
  state text not null,
  error_code text,
  error_message text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  attempted_at timestamptz not null default now(),
  unique(notification_id,attempt_number)
);
create index if not exists notification_delivery_attempts_notification_idx on notification_delivery_attempts(notification_id,attempt_number desc);

alter table notification_outbox add column if not exists locked_at timestamptz;
alter table notification_outbox add column if not exists locked_by text;
alter table notification_outbox add column if not exists max_attempts integer not null default 5;
alter table notification_outbox add column if not exists provider text;
alter table notification_outbox add column if not exists provider_message_id text;

create table if not exists notification_channel_configs (
  channel text primary key,
  provider text not null,
  enabled boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into notification_channel_configs(channel,provider,enabled) values
('push','internal',true),
('email','internal',false),
('sms','internal',false)
on conflict(channel) do nothing;
