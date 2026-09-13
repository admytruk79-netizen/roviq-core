-- Real Web Push (RFC 8291/8292) for the 'push' channel, replacing the no-op 'internal' adapter
-- that notification_channel_configs has defaulted to since 011_notifications_delivery.sql. Unlike
-- sms (Twilio) and email (Resend), Web Push needs no third-party account: the application server
-- identifies itself to push services with a self-generated VAPID keypair, and each subscribed
-- browser hands back an endpoint plus a p256dh/auth keypair the server encrypts payloads against.
-- One actor can have several live subscriptions (multiple browsers/devices), so this dedupes on
-- endpoint rather than actor_id.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references actors(id),
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(endpoint)
);
create index if not exists push_subscriptions_actor_idx on push_subscriptions(actor_id);

-- Same customer_status_update template already used by sms (027_identity_phone.sql) and email
-- (046_customer_status_email_channel.sql), so setCustomerSnapshot can queue all three channels
-- identically once push is wired into that loop. notification_channel_configs.push is left as-is
-- (011_notifications_delivery.sql: provider='internal', enabled=true) -- same as sms/email, an
-- admin opts in to the real provider via PUT /api/admin/notifications/channels/push once
-- VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT are configured, rather than this migration
-- silently repointing an already-live channel at a provider that isn't configured yet.
insert into notification_templates(template_key,channel,subject_template,body_template,active)
values('customer_status_update','push','ROVIQ update','{{message}}',true)
on conflict(template_key,channel,version) do nothing;
