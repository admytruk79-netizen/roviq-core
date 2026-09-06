-- ROVIQ Core migration 036
-- Preserve explicit technician clock semantics when work or repair orders are cancelled.

begin;

alter table shop_technician_time_entries
  drop constraint if exists shop_technician_time_entries_end_reason_check;

alter table shop_technician_time_entries
  add constraint shop_technician_time_entries_end_reason_check
  check (end_reason is null or end_reason in ('pause','complete','switch','manual','cancel'));

commit;
