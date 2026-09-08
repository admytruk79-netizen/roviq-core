-- Forward-only repair for environments where migration 044 removed provenance markers
-- recovered correctly by migration 043. Historical migrations remain immutable.
--
-- Migration 039 ran after the previous recorded migration and before its own ledger row
-- was recorded. Restrict recovery to that execution interval and to rows whose destination
-- still equals the canonical case destination and have no explicit provenance marker.

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

-- Reconcile recovered active inherited destinations to the current canonical destination.
update transport_dispatches td
   set dropoff_location=s.destination
  from case_spatial_context s
 where s.case_id=td.case_id
   and td.status not in ('delivered','cancelled')
   and td.metadata->>'dropoffSource'='case_spatial'
   and s.destination is not null
   and s.destination<>'{}'::jsonb
   and td.dropoff_location is distinct from s.destination;
