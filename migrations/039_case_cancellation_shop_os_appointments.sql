-- ROVIQ Core migration 039
-- Cancelling a Service Case atomically terminates linked active Shop OS appointments
-- and releases their occupancy without re-enabling blocked/stale capacity windows.

begin;

create or replace function shop_os_cancel_case_appointments()
returns trigger language plpgsql as $$
declare
  appt record;
  resource_id_value uuid;
  affected_resources uuid[] := array[]::uuid[];
begin
  if new.state='cancelled' and old.state is distinct from new.state then
    for appt in
      update roviq_appointments
         set appointment_status='cancelled',
             released_reason=coalesce(released_reason,'service_case_cancelled'),
             lifecycle_version=lifecycle_version+1,
             updated_at=now()
       where service_case_id=new.id
         and appointment_status in ('held','confirmed','in_progress')
       returning *
    loop
      if not (appt.resource_id = any(affected_resources)) then
        affected_resources:=array_append(affected_resources,appt.resource_id);
      end if;

      insert into events(aggregate_type,aggregate_id,event_type,actor_id,payload)
      values('service_case',new.id,'SHOP_OS_APPOINTMENT_CANCELLED',null,
        jsonb_build_object(
          'appointmentId',appt.id,
          'resourceId',appt.resource_id,
          'status','cancelled',
          'reason','service_case_cancelled'
        ));

      if appt.source_connection_id is not null then
        insert into integration_sync_events(
          connection_id,event_type,direction,status,roviq_entity_type,roviq_entity_id,payload
        ) values(
          appt.source_connection_id,'shop_os_appointment_cancelled','internal','accepted','appointment',appt.id,
          jsonb_build_object(
            'serviceCaseId',new.id,
            'resourceId',appt.resource_id,
            'status','cancelled',
            'reason','service_case_cancelled'
          )
        );
      end if;
    end loop;

    foreach resource_id_value in array affected_resources loop
      with window_events as (
        select cw.id,greatest(a.starts_at,cw.window_start) as at,1::int as delta
        from capacity_windows cw
        join roviq_appointments a
          on a.resource_id=cw.resource_id
         and a.appointment_status in ('held','confirmed','in_progress')
         and a.starts_at<cw.window_end and a.ends_at>cw.window_start
        where cw.resource_id=resource_id_value
        union all
        select cw.id,least(a.ends_at,cw.window_end) as at,-1::int as delta
        from capacity_windows cw
        join roviq_appointments a
          on a.resource_id=cw.resource_id
         and a.appointment_status in ('held','confirmed','in_progress')
         and a.starts_at<cw.window_end and a.ends_at>cw.window_start
        where cw.resource_id=resource_id_value
      ), grouped as (
        select id,at,sum(delta)::int as delta from window_events group by id,at
      ), running as (
        select id,sum(delta) over(partition by id order by at rows unbounded preceding)::int as concurrent
        from grouped
      ), peaks as (
        select id,coalesce(max(concurrent),0)::int as peak from running group by id
      ), recalculated as (
        select cw.id,cw.nominal_capacity_units,
          greatest(cw.nominal_capacity_units-coalesce(p.peak,0),0)::int as available_units
        from capacity_windows cw
        left join peaks p on p.id=cw.id
        where cw.resource_id=resource_id_value
      )
      update capacity_windows cw
         set capacity_units=r.available_units,
             capacity_state=case
               when cw.capacity_state in ('blocked','unknown') then cw.capacity_state
               when cw.sync_state<>'current' then cw.capacity_state
               when r.available_units<=0 then 'full'
               when r.available_units<r.nominal_capacity_units then 'limited'
               else 'available'
             end,
             updated_at=now()
        from recalculated r
       where cw.id=r.id;
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists trg_shop_os_cancel_case_appointments on service_cases;
create trigger trg_shop_os_cancel_case_appointments
after update of state on service_cases
for each row execute function shop_os_cancel_case_appointments();

commit;
