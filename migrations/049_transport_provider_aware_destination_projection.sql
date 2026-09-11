-- Keep destination-triggered transport-readiness projection aligned with the
-- provider-aware application derivation. Historical migrations remain immutable.
--
-- A delivered dispatch is terminal and remains satisfied even if its provider later
-- becomes inactive. Active pre-delivery states require an active provider.

create or replace function sync_transport_destination_from_case_spatial()
returns trigger
language plpgsql
as $$
declare
  latest record;
  derived_status text;
  destination_ready boolean;
  provider_ready boolean;
begin
  if new.destination is null or new.destination='{}'::jsonb then
    return new;
  end if;

  update transport_dispatches
     set dropoff_location=new.destination,
         metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('dropoffSource','case_spatial')
   where case_id=new.case_id
     and status not in ('delivered','cancelled')
     and (
       coalesce(dropoff_location,'{}'::jsonb)='{}'::jsonb
       or metadata->>'dropoffSource'='case_spatial'
     );

  select td.id,
         td.transport_type,
         td.status,
         td.dropoff_location,
         td.provider_actor_id,
         td.eta_at,
         td.dispatch_sequence,
         a.status as provider_status
    into latest
    from transport_dispatches td
    left join actors a on a.id=td.provider_actor_id
   where td.case_id=new.case_id
     and td.status<>'cancelled'
   order by td.dispatch_sequence desc
   limit 1;

  if found then
    destination_ready:=latest.dropoff_location is not null and latest.dropoff_location<>'{}'::jsonb;
    provider_ready:=latest.provider_actor_id is not null and latest.provider_status='active';

    derived_status:=case
      when latest.status in ('declined','failed') then 'blocked'
      when not destination_ready then 'required'
      when latest.status='assigned' and latest.provider_actor_id is not null and not provider_ready then 'blocked'
      when latest.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit') and not provider_ready then 'blocked'
      when latest.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit','delivered') then 'satisfied'
      when latest.status in ('requested','assigned') then 'required'
      else 'unknown'
    end;

    update case_constraints
       set status=derived_status,
           details=coalesce(details,'{}'::jsonb) || jsonb_build_object(
             'dispatchId',latest.id,
             'transportType',latest.transport_type,
             'transportStatus',latest.status,
             'destinationReady',destination_ready,
             'providerReady',case when latest.provider_actor_id is null then null else provider_ready end,
             'providerActorId',latest.provider_actor_id,
             'providerStatus',latest.provider_status,
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

-- Repair existing transport projections immediately so environments do not have to
-- wait for the next destination or transport mutation to become provider-aware.
with latest as (
  select distinct on (td.case_id)
         td.case_id,
         td.id,
         td.transport_type,
         td.status,
         td.dropoff_location,
         td.provider_actor_id,
         td.eta_at,
         a.status as provider_status
    from transport_dispatches td
    left join actors a on a.id=td.provider_actor_id
   where td.status<>'cancelled'
   order by td.case_id,td.dispatch_sequence desc
), derived as (
  select latest.*,
         (latest.dropoff_location is not null and latest.dropoff_location<>'{}'::jsonb) as destination_ready,
         (latest.provider_actor_id is not null and latest.provider_status='active') as provider_ready
    from latest
)
update case_constraints cc
   set status=case
         when d.status in ('declined','failed') then 'blocked'
         when not d.destination_ready then 'required'
         when d.status='assigned' and d.provider_actor_id is not null and not d.provider_ready then 'blocked'
         when d.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit') and not d.provider_ready then 'blocked'
         when d.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit','delivered') then 'satisfied'
         when d.status in ('requested','assigned') then 'required'
         else 'unknown'
       end,
       details=coalesce(cc.details,'{}'::jsonb) || jsonb_build_object(
         'dispatchId',d.id,
         'transportType',d.transport_type,
         'transportStatus',d.status,
         'destinationReady',d.destination_ready,
         'providerReady',case when d.provider_actor_id is null then null else d.provider_ready end,
         'providerActorId',d.provider_actor_id,
         'providerStatus',d.provider_status,
         'etaAt',d.eta_at
       ),
       source_updated_at=now(),
       updated_at=now()
  from derived d
 where cc.service_case_id=d.case_id
   and cc.projection_key='transport-readiness'
   and cc.source_type='operational_projection';
