-- Project a selected repair provider's canonical location into the Service Case destination.
-- This closes the tow -> repair handoff loop: an active tow can be picked up before a
-- repair provider is chosen, then provider selection supplies the destination required
-- for delivery. The existing case_spatial_context destination trigger propagates this
-- canonical destination to active transport dispatches while preserving explicit
-- dispatch-level overrides.

create or replace function sync_selected_provider_destination()
returns trigger
language plpgsql
as $$
declare
  provider_location jsonb;
begin
  if new.selected_actor_id is null
     or new.selected_actor_id is not distinct from old.selected_actor_id then
    return new;
  end if;

  select jsonb_strip_nulls(jsonb_build_object(
           'locationId', l.id,
           'name', l.name,
           'address', l.address,
           'lat', l.latitude,
           'lng', l.longitude,
           'city', l.city,
           'region', l.region,
           'countryCode', l.country_code,
           'providerActorId', a.id
         ))
    into provider_location
    from actors a
    join locations l on l.id=a.location_id
   where a.id=new.selected_actor_id
     and a.status='active';

  -- Fail closed when the selected actor has no canonical location: leave the existing
  -- destination untouched so transport delivery remains blocked rather than inventing
  -- or silently substituting a destination.
  if provider_location is null or provider_location='{}'::jsonb then
    return new;
  end if;

  insert into case_spatial_context(case_id,destination,source,updated_at)
  values(new.id,provider_location,'selected_provider',now())
  on conflict(case_id) do update
     set destination=excluded.destination,
         source='selected_provider',
         updated_at=now()
   where case_spatial_context.destination is null
      or case_spatial_context.destination='{}'::jsonb
      or case_spatial_context.source='selected_provider';

  return new;
end;
$$;

drop trigger if exists trg_sync_selected_provider_destination on service_cases;
create trigger trg_sync_selected_provider_destination
after update of selected_actor_id on service_cases
for each row
when (new.selected_actor_id is not null and new.selected_actor_id is distinct from old.selected_actor_id)
execute function sync_selected_provider_destination();

-- Forward repair for already-selected cases whose destination has not yet been
-- established. Do not overwrite an explicit or independently established destination.
insert into case_spatial_context(case_id,destination,source,updated_at)
select sc.id,
       jsonb_strip_nulls(jsonb_build_object(
         'locationId',l.id,
         'name',l.name,
         'address',l.address,
         'lat',l.latitude,
         'lng',l.longitude,
         'city',l.city,
         'region',l.region,
         'countryCode',l.country_code,
         'providerActorId',a.id
       )),
       'selected_provider',
       now()
  from service_cases sc
  join actors a on a.id=sc.selected_actor_id and a.status='active'
  join locations l on l.id=a.location_id
 where sc.selected_actor_id is not null
on conflict(case_id) do update
   set destination=excluded.destination,
       source='selected_provider',
       updated_at=now()
 where case_spatial_context.destination is null
    or case_spatial_context.destination='{}'::jsonb
    or case_spatial_context.source='selected_provider';
