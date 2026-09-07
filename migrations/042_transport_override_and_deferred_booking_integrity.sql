-- Keep per-dispatch transport overrides out of canonical case spatial state, and enforce
-- deferred-service booking against the same Service Case. This is a forward-only correction;
-- previously published migrations remain immutable.

create or replace function protect_case_spatial_from_transport_dispatch()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'transport_dispatch' then
    if tg_op = 'UPDATE' then
      -- createTransportDispatch may mirror resolved dispatch coordinates into case_spatial_context.
      -- Those are execution snapshots, not a canonical case-location edit. Preserve the canonical
      -- coordinates so an explicit destination on one dispatch cannot redirect sibling trips.
      new.origin := old.origin;
      new.current_vehicle := old.current_vehicle;
      new.destination := old.destination;
      new.source := old.source;
    else
      -- On a previously spatially-empty case, keep the row available for later live GPS fields but
      -- do not promote dispatch-specific coordinates into canonical origin/destination truth.
      new.origin := null;
      new.current_vehicle := null;
      new.destination := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_case_spatial_from_transport_dispatch on case_spatial_context;
create trigger trg_protect_case_spatial_from_transport_dispatch
before insert or update on case_spatial_context
for each row
execute function protect_case_spatial_from_transport_dispatch();

create or replace function enforce_deferred_service_appointment_case()
returns trigger
language plpgsql
as $$
declare
  appointment_case_id uuid;
begin
  if new.booked_appointment_id is null then
    return new;
  end if;
  if new.service_case_id is null then
    raise exception using errcode='23514', message='deferred_service_case_required_for_booking';
  end if;
  select service_case_id into appointment_case_id
    from roviq_appointments
   where id=new.booked_appointment_id;
  if appointment_case_id is null or appointment_case_id <> new.service_case_id then
    raise exception using errcode='23514', message='deferred_service_appointment_case_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_deferred_service_appointment_case on shop_deferred_service_items;
create trigger trg_enforce_deferred_service_appointment_case
before insert or update of booked_appointment_id,service_case_id on shop_deferred_service_items
for each row
execute function enforce_deferred_service_appointment_case();
