-- Forward correction for environments that already applied migration 039 before destination
-- provenance/recency hardening. Recreate the trigger function with the safe rules and tag only
-- destinationless active dispatches when a canonical destination is available. Nonempty untagged
-- legacy destinations are deliberately left untouched because their override intent is unknowable.

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
         metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('dropoffSource','case_spatial')
   where case_id = new.case_id
     and status not in ('delivered','cancelled')
     and (
       coalesce(dropoff_location,'{}'::jsonb) = '{}'::jsonb
       or metadata->>'dropoffSource' = 'case_spatial'
     );

  select id, transport_type, status, dropoff_location, provider_actor_id, eta_at
    into latest
    from transport_dispatches
   where case_id = new.case_id
     and status <> 'cancelled'
   order by updated_at desc, created_at desc, id desc
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
           details = coalesce(details,'{}'::jsonb) || jsonb_build_object(
             'dispatchId',latest.id,
             'transportType',latest.transport_type,
             'transportStatus',latest.status,
             'destinationReady',latest.dropoff_location is not null and latest.dropoff_location <> '{}'::jsonb,
             'providerActorId',latest.provider_actor_id,
             'etaAt',latest.eta_at
           ),
           source_updated_at=now(),
           updated_at=now()
     where service_case_id=new.case_id
       and projection_key='transport-readiness'
       and source_type='operational_projection';
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

update transport_dispatches td
   set dropoff_location=s.destination,
       metadata=coalesce(td.metadata,'{}'::jsonb) || jsonb_build_object('dropoffSource','case_spatial')
  from case_spatial_context s
 where s.case_id=td.case_id
   and s.destination is not null
   and s.destination <> '{}'::jsonb
   and coalesce(td.dropoff_location,'{}'::jsonb)='{}'::jsonb
   and td.status not in ('delivered','cancelled');
