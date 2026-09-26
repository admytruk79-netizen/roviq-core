-- New vs used, so the public site can show and filter each separately.
alter table vehicle_inventory add column if not exists condition text
  check (condition is null or condition in ('new','used'));
update vehicle_inventory set condition='used' where condition is null;
