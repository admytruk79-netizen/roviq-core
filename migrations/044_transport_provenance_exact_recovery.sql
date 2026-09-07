-- Forward correction for 043_transport_provenance_recovery.sql.
-- Keep 039-043 immutable: any of them may already be recorded by deployed environments.
--
-- PostgreSQL now() is the transaction-start timestamp. The migrator executes each migration SQL
-- and inserts its schema_migrations row inside the same BEGIN/COMMIT transaction. Therefore every
-- transport_dispatches row touched by migration 039's backfill has updated_at exactly equal to the
-- applied_at recorded for 039. That equality is the deterministic provenance marker.

with migration_039 as (
  select applied_at
    from schema_migrations
   where filename='039_transport_destination_coherence.sql'
   limit 1
), bounds as (
  select m.applied_at as applied_at,
         coalesce((
           select max(prev.applied_at)
             from schema_migrations prev
            where prev.applied_at < m.applied_at
         ),'-infinity'::timestamptz) as previous_applied_at
    from migration_039 m
)
-- 043 used the whole interval between adjacent migration records. Any case_spatial tag it placed
-- inside that interval but outside 039's exact transaction timestamp was not produced by 039 and
-- must not be allowed to overwrite a deliberate dispatch-level destination later.
update transport_dispatches td
   set metadata = coalesce(td.metadata,'{}'::jsonb) - 'dropoffSource'
  from bounds b
 where td.metadata->>'dropoffSource'='case_spatial'
   and td.updated_at>b.previous_applied_at
   and td.updated_at<b.applied_at
   and td.updated_at<>b.applied_at;

with migration_039 as (
  select applied_at
    from schema_migrations
   where filename='039_transport_destination_coherence.sql'
   limit 1
)
-- Rows whose updated_at equals 039.applied_at are exactly the rows whose empty destination was
-- backfilled by 039. Mark them inherited and, for active dispatches, immediately reconcile them to
-- the current canonical destination without touching updated_at/dispatch ordering metadata.
update transport_dispatches td
   set dropoff_location = case
         when td.status not in ('delivered','cancelled')
          and s.destination is not null
          and s.destination<>'{}'::jsonb
           then s.destination
         else td.dropoff_location
       end,
       metadata = coalesce(td.metadata,'{}'::jsonb) || jsonb_build_object('dropoffSource','case_spatial')
  from case_spatial_context s,migration_039 m
 where s.case_id=td.case_id
   and td.updated_at=m.applied_at;

-- Reassert the provenance-aware trigger after repairing the legacy rows. Explicit dispatch
-- destinations remain isolated; inherited destinations continue following canonical corrections.
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
