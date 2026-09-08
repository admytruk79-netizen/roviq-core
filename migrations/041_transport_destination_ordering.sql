-- Forward hardening for migration 039's published backfill behavior.
-- 039 must remain byte-for-byte stable because deployed environments may already have its checksum.
-- This migration recovers provenance for rows 039 actually backfilled and introduces an immutable
-- dispatch sequence so transport-readiness never depends on updated_at values touched by sync work.

create sequence if not exists transport_dispatch_sequence_seq;

alter table transport_dispatches
  add column if not exists dispatch_sequence bigint;

-- Deterministically order all existing dispatches by their immutable creation time. UUID is used
-- only to break an exact creation-time tie during one-time backfill; future rows use the sequence.
with ranked as (
  select id,row_number() over(order by created_at asc,id asc)::bigint as seq
    from transport_dispatches
)
update transport_dispatches td
   set dispatch_sequence=ranked.seq
  from ranked
 where td.id=ranked.id
   and td.dispatch_sequence is null;

select setval(
  'transport_dispatch_sequence_seq',
  coalesce((select max(dispatch_sequence) from transport_dispatches),0)+1,
  false
);

alter table transport_dispatches
  alter column dispatch_sequence set default nextval('transport_dispatch_sequence_seq');

update transport_dispatches
   set dispatch_sequence=nextval('transport_dispatch_sequence_seq')
 where dispatch_sequence is null;

alter table transport_dispatches
  alter column dispatch_sequence set not null;

create unique index if not exists ux_transport_dispatch_sequence
  on transport_dispatches(dispatch_sequence);

-- Recover provenance only for rows that migration 039 itself changed. PostgreSQL now() is stable
-- for the whole migration transaction, so 039's backfill updated_at equals schema_migrations.applied_at
-- for that exact file. This avoids guessing based only on destination equality and therefore does not
-- relabel deliberate dispatch-level destinations that merely happen to equal the canonical case value.
update transport_dispatches td
   set metadata=coalesce(td.metadata,'{}'::jsonb) || jsonb_build_object('dropoffSource','case_spatial')
  from case_spatial_context s,
       schema_migrations m
 where m.filename='039_transport_destination_coherence.sql'
   and s.case_id=td.case_id
   and td.updated_at=m.applied_at
   and td.dropoff_location=s.destination
   and s.destination is not null
   and s.destination<>'{}'::jsonb
   and coalesce(td.metadata->>'dropoffSource','')='';

-- Replace the destination trigger with provenance-aware sync that never mutates dispatch recency.
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

-- Repair any transport-readiness projection that migration 039 may have pointed at the wrong row
-- after touching several dispatch updated_at values at once. Current dispatch is defined only by
-- immutable dispatch_sequence from this point onward.
with latest as (
  select distinct on (case_id)
         case_id,id,transport_type,status,dropoff_location,provider_actor_id,eta_at
    from transport_dispatches
   where status<>'cancelled'
   order by case_id,dispatch_sequence desc
)
update case_constraints cc
   set status=case
         when latest.status in ('declined','failed') then 'blocked'
         when latest.dropoff_location is null or latest.dropoff_location='{}'::jsonb then 'required'
         when latest.status in ('accepted','en_route','arrived','vehicle_loaded','in_transit','delivered') then 'satisfied'
         when latest.status in ('requested','assigned') then 'required'
         else 'unknown'
       end,
       details=coalesce(cc.details,'{}'::jsonb) || jsonb_build_object(
         'dispatchId',latest.id,
         'transportType',latest.transport_type,
         'transportStatus',latest.status,
         'destinationReady',latest.dropoff_location is not null and latest.dropoff_location<>'{}'::jsonb,
         'providerActorId',latest.provider_actor_id,
         'etaAt',latest.eta_at
       ),
       source_updated_at=now(),
       updated_at=now()
  from latest
 where cc.service_case_id=latest.case_id
   and cc.projection_key='transport-readiness'
   and cc.source_type='operational_projection';
