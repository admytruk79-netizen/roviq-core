-- ROVIQ Core migration 052
-- Provider event identifiers are only unique within a provider namespace.

begin;

alter table payment_events
  add column if not exists provider text;

update payment_events pe
set provider=lower(coalesce(nullif(trim(pi.provider),''),'manual'))
from payment_intents pi
where pi.id=pe.payment_intent_id
  and pe.provider is null;

update payment_events
set provider='manual'
where provider is null;

alter table payment_events
  alter column provider set default 'manual';

alter table payment_events
  alter column provider set not null;

drop index if exists payment_events_provider_event_idx;

create unique index if not exists payment_events_provider_event_provider_idx
  on payment_events(provider,provider_event_id)
  where provider_event_id is not null;

commit;
