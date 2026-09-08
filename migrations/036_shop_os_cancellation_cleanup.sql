-- ROVIQ Core migration 036
-- Preserve an explicit audit reason when repair-order cancellation closes active technician clocks.

begin;

alter table shop_technician_time_entries
  drop constraint if exists shop_technician_time_entries_end_reason_check;

alter table shop_technician_time_entries
  add constraint shop_technician_time_entries_end_reason_check
  check (end_reason is null or end_reason in ('pause','complete','switch','manual','order_cancelled'));

commit;
