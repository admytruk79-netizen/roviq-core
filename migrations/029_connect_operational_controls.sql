-- ROVIQ Core migration 029
-- Operational controls and health state for ROVIQ Connect / Bridge Mode.

begin;

alter table partner_system_connections
  add column if not exists credential_state text not null default 'unknown'
    check (credential_state in ('unknown','configured','valid','expiring','expired','revoked','error'));
alter table partner_system_connections
  add column if not exists access_state text not null default 'unknown'
    check (access_state in ('unknown','authorized','limited','denied','revoked'));
alter table partner_system_connections
  add column if not exists fallback_mode text not null default 'none'
    check (fallback_mode in ('none','bridge','manual'));
alter table partner_system_connections add column if not exists fallback_enabled boolean not null default false;
alter table partner_system_connections add column if not exists status_reason text;
alter table partner_system_connections add column if not exists health_checked_at timestamptz;
alter table partner_system_connections add column if not exists last_failure_at timestamptz;
alter table partner_system_connections add column if not exists paused_at timestamptz;
alter table partner_system_connections add column if not exists revoked_at timestamptz;
alter table partner_system_connections add column if not exists credential_expires_at timestamptz;

create index if not exists idx_partner_system_connections_health
  on partner_system_connections(connection_status,credential_state,access_state,health_checked_at);

commit;
