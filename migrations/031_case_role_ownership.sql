-- ROVIQ Core migration 031
-- Cross-role Service Case ownership projection.
-- Keeps one canonical case while making the role currently responsible for
-- advancing it explicit to every role-specific surface.

begin;

create or replace function project_service_case_owner()
returns trigger
language plpgsql
as $$
begin
  case new.state
    when 'intake' then
      new.current_owner_role := 'customer';
      new.current_owner_actor_id := new.customer_actor_id;
    when 'triage', 'provider_selection', 'payment_pending' then
      new.current_owner_role := 'admin';
      new.current_owner_actor_id := null;
    when 'diagnostic_pending', 'diagnostic_in_progress' then
      -- Entering diagnostic work from another role must clear stale ownership,
      -- but once a diagnostic assignment has been accepted, preserve the
      -- concrete actor while the case advances within diagnostic states.
      if tg_op='UPDATE' and old.current_owner_role='diagnostic' then
        new.current_owner_actor_id := old.current_owner_actor_id;
      else
        new.current_owner_actor_id := null;
      end if;
      new.current_owner_role := 'diagnostic';
    when 'tow_pending', 'tow_in_progress' then
      -- Same rule for transport: assignment flows write the tow actor first,
      -- then advance the case state. Do not erase that accepted assignment.
      if tg_op='UPDATE' and old.current_owner_role='tow' then
        new.current_owner_actor_id := old.current_owner_actor_id;
      else
        new.current_owner_actor_id := null;
      end if;
      new.current_owner_role := 'tow';
    when 'provider_pending', 'repair_in_progress' then
      new.current_owner_role := 'partner';
      new.current_owner_actor_id := new.selected_actor_id;
    when 'parts_pending' then
      new.current_owner_role := 'parts';
      new.current_owner_actor_id := null;
    when 'completed', 'cancelled' then
      new.current_owner_role := null;
      new.current_owner_actor_id := null;
    else
      new.current_owner_role := null;
      new.current_owner_actor_id := null;
  end case;
  return new;
end;
$$;

drop trigger if exists trg_project_service_case_owner on service_cases;
create trigger trg_project_service_case_owner
before insert or update of state,customer_actor_id,selected_actor_id
on service_cases
for each row execute function project_service_case_owner();

-- Backfill existing cases onto the same projection without inventing a second
-- workflow or changing their state. Existing assigned diagnostic/tow owners are
-- preserved when their role already matches the case's active role.
update service_cases
set state=state;

create index if not exists service_cases_owner_role_idx
  on service_cases(current_owner_role,state,updated_at desc);

commit;
