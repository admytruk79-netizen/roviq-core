-- Real SMS delivery needs a real phone number to send to. The `users` table (migration 003) has a
-- phone column but is dead schema -- it's never referenced anywhere in src/. The actual recipient
-- concept notifications already use is the actor (notification_outbox.recipient_id is an actor id),
-- and principal_identities rows don't always exist for an actor (dev-header/test auth never creates
-- one), so the phone belongs on actors itself rather than resurrecting users or depending on identity.
alter table actors add column if not exists phone text;
create unique index if not exists actors_phone_idx on actors(phone) where phone is not null;

-- Default body for the 'sms' channel's customer_status_update notifications queued by
-- setCustomerSnapshot (src/services/operations.ts). Kept to one plain line: the renderer
-- (render() in src/services/notifications.ts and processNotificationBatchNative in
-- cloudflare/worker.js) is a bare {{key}} substitution with no conditionals, so a template
-- referencing next_action/eta_at would render an awkward trailing fragment on the (common) calls
-- that only pass a message.
insert into notification_templates(template_key,channel,body_template,active)
values('customer_status_update','sms','ROVIQ: {{message}}',true)
on conflict(template_key,channel,version) do nothing;
