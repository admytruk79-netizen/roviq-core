-- The 'email' notification channel (011_notifications_delivery.sql) has existed since the
-- outbox was built, but nothing ever queued anything through it: setCustomerSnapshot
-- (src/services/operations.ts) only ever queued the 'sms' channel's customer_status_update
-- notification. Give email the same default template so it can carry the identical status
-- updates once an admin enables it with a real provider, mirroring 027_identity_phone.sql's
-- sms template exactly except for a subject line, which email supports and sms doesn't.
insert into notification_templates(template_key,channel,subject_template,body_template,active)
values('customer_status_update','email','ROVIQ update: {{status}}','{{message}}',true)
on conflict(template_key,channel,version) do nothing;
