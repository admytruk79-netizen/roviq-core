-- ROVIQ Core migration 038
-- Harden Shop OS completion history and deferred-work synchronization.

begin;

alter table shop_technician_time_entries
  add column if not exists hourly_cost_snapshot numeric(12,2);

update shop_technician_time_entries te
set hourly_cost_snapshot=coalesce(te.hourly_cost_snapshot,sr.hourly_cost,0)
from service_resources sr
where sr.id=te.technician_resource_id and te.hourly_cost_snapshot is null;

update shop_technician_time_entries
set hourly_cost_snapshot=0
where hourly_cost_snapshot is null;

alter table shop_technician_time_entries
  alter column hourly_cost_snapshot set default 0,
  alter column hourly_cost_snapshot set not null;

alter table shop_technician_time_entries
  drop constraint if exists shop_technician_time_entries_hourly_cost_snapshot_check;
alter table shop_technician_time_entries
  add constraint shop_technician_time_entries_hourly_cost_snapshot_check
  check (hourly_cost_snapshot >= 0);

create or replace function shop_os_snapshot_technician_rate()
returns trigger language plpgsql as $$
begin
  if new.hourly_cost_snapshot is null or (tg_op='INSERT' and new.hourly_cost_snapshot=0) then
    select coalesce(hourly_cost,0) into new.hourly_cost_snapshot
    from service_resources where id=new.technician_resource_id;
    new.hourly_cost_snapshot:=coalesce(new.hourly_cost_snapshot,0);
  end if;
  return new;
end $$;

drop trigger if exists trg_shop_os_snapshot_technician_rate on shop_technician_time_entries;
create trigger trg_shop_os_snapshot_technician_rate
before insert on shop_technician_time_entries
for each row execute function shop_os_snapshot_technician_rate();

create or replace function shop_os_sync_deferred_line_state()
returns trigger language plpgsql as $$
begin
  if new.approval_status is distinct from old.approval_status then
    if old.approval_status in ('deferred','declined') and new.approval_status not in ('deferred','declined') then
      update shop_deferred_service_items
      set status='dismissed',dismissed_at=coalesce(dismissed_at,now()),next_follow_up_at=null,updated_at=now()
      where repair_order_line_id=new.id and status in ('open','reminded','booked');
    elsif new.approval_status in ('deferred','declined') then
      update shop_deferred_service_items
      set status='open',dismissed_at=null,completed_at=null,booked_appointment_id=null,updated_at=now()
      where repair_order_line_id=new.id and status in ('dismissed','completed');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_shop_os_sync_deferred_line_state on shop_repair_order_lines;
create trigger trg_shop_os_sync_deferred_line_state
after update of approval_status on shop_repair_order_lines
for each row execute function shop_os_sync_deferred_line_state();

create or replace function shop_os_guard_repair_order_completion()
returns trigger language plpgsql as $$
declare n integer;
begin
  if new.status in ('completed','closed') and old.status is distinct from new.status then
    select count(*) into n from shop_work_items
      where repair_order_id=new.id and status not in ('completed','cancelled');
    if n>0 then raise exception 'repair_order_work_incomplete'; end if;

    select count(*) into n from shop_technician_time_entries
      where repair_order_id=new.id and ended_at is null;
    if n>0 then raise exception 'repair_order_time_open'; end if;

    select count(*) into n from case_parts_requirements
      where repair_order_id=new.id and readiness_status not in ('ready','cancelled');
    if n>0 then raise exception 'repair_order_parts_unresolved'; end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_shop_os_guard_repair_order_completion on shop_repair_orders;
create trigger trg_shop_os_guard_repair_order_completion
before update of status on shop_repair_orders
for each row execute function shop_os_guard_repair_order_completion();

commit;
