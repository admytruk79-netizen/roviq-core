-- Forward-only repair for legacy rows populated by 039_transport_destination_coherence.sql.
-- Do not modify migrations 039-041: deployed environments may already have their checksums.
--
-- The migrator records schema_migrations.applied_at only after each migration finishes, so the
-- equality assumption used by 041 cannot identify rows whose updated_at was set by 039's now().
-- We can, however, identify the 039 execution interval deterministically: its transaction starts
-- after the previously recorded migration and finishes before its own schema_migrations row is
-- recorded. Restrict recovery further to untagged rows whose destination equals the canonical case
-- destination, which is exactly the shape produced by 039's empty-destination backfill.

with target as (
  select applied_at
    from schema_migrations
   where filename='039_transport_destination_coherence.sql'
   limit 1
), bounds as (
  select target.applied_at as finished_at,
         coalesce((
           select max(m.applied_at)
             from schema_migrations m,target t
            where m.applied_at<t.applied_at
         ),'-infinity'::timestamptz) as started_after
    from target
)
update transport_dispatches td
   set metadata=coalesce(td.metadata,'{}'::jsonb) || jsonb_build_object('dropoffSource','case_spatial')
  from case_spatial_context s,bounds b
 where s.case_id=td.case_id
   and td.updated_at>b.started_after
   and td.updated_at<b.finished_at
   and td.dropoff_location=s.destination
   and s.destination is not null
   and s.destination<>'{}'::jsonb
   and coalesce(td.metadata->>'dropoffSource','')='';

-- Reassert provenance-aware propagation. Recovered inherited rows now continue following later
-- canonical destination corrections, while explicit_dispatch rows remain protected.
create or replace function sync_transport_destination_from_case_spatial()
returns trigger
language plpgsql
as $$
declare
  latest record;
  derived_status text;
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

  select id,transport_type,status,dropoff_location,provider_actor_id,eta_at,dispatch_sequence
    into latest
    from transport_dispatches
   where case_id=new.case_id
     and status<>'cancelled'
   order by dispatch_sequence desc
   limit 1;

  if found then
    derived_status:=case
      when latest.status in ('declined','failed') then 'blocked'
      when latest.dropoff_location is null or latest.dropoff_location='{}'::jsonb then 'required'
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
             'destinationReady',latest.dropoff_location is not null and latest.dropoff_location<>'{}'::jsonb,
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
