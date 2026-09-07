-- Keep transport dispatch destination state coherent with the canonical Service Case spatial context.
-- A destination may be assigned after the dispatch already exists. Read projections already treat
-- case_spatial_context.destination as effective transport truth, so persist that late destination
-- into active dispatch rows and refresh the serviceability projection at the same boundary.

create or replace function sync_transport_destination_from_case_spatial()
returns trigger
language plpgsql
as $$
declare
  latest record;
  derived_status text;
begin
  if new.destination is null or new.destination = '{}'::jsonb then
    return new;
  end if;

  update transport_dispatches
     set dropoff_location = new.destination,
         updated_at = now()
   where case_id = new.case_id
     and coalesce(dropoff_location, '{}'::jsonb) = '{}'::jsonb
     and status not in ('delivered','cancelled');

  select id, transport_type, status, dropoff_location, provider_actor_id, eta_at
    into latest
    from transport_dispatches
   where case_id = new.case_id
     and status <> 'cancelled'
   order by updated_at desc, id desc
   limit 1;

  if found then
    derived_status := case
      when latest.status in ('declined','failed') then 'blocked'
      when latest.dropoff_location is null or latest.dropoff_location = '{}'::jsonb then 'required'
      when latest.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit','delivered') then 'satisfied'
      when latest.status in ('requested','assigned') then 'required'
      else 'unknown'
    end;

    update case_constraints
       set status = derived_status,
           details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
             'dispatchId', latest.id,
             'transportType', latest.transport_type,
             'transportStatus', latest.status,
             'destinationReady', true,
             'providerActorId', latest.provider_actor_id,
             'etaAt', latest.eta_at
           ),
           source_updated_at = now(),
           updated_at = now()
     where service_case_id = new.case_id
       and projection_key = 'transport-readiness'
       and source_type = 'operational_projection';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_transport_destination_from_case_spatial on case_spatial_context;
create trigger trg_sync_transport_destination_from_case_spatial
after insert or update of destination on case_spatial_context
for each row
when (new.destination is not null and new.destination <> '{}'::jsonb)
execute function sync_transport_destination_from_case_spatial();

-- Backfill active dispatches that predate this coherence rule.
update transport_dispatches td
   set dropoff_location = s.destination,
       updated_at = now()
  from case_spatial_context s
 where s.case_id = td.case_id
   and s.destination is not null
   and s.destination <> '{}'::jsonb
   and coalesce(td.dropoff_location, '{}'::jsonb) = '{}'::jsonb
   and td.status not in ('delivered','cancelled');
