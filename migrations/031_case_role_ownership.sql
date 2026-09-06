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
      new.current_owner_role := 'diagnostic';
      new.current_owner_actor_id := null;
    when 'tow_pending', 'tow_in_progress' then
      new.current_owner_role := 'tow';
      new.current_owner_actor_id := null;
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
-- workflow or changing their state.
update service_cases
set state=state;

create index if not exists service_cases_owner_role_idx
  on service_cases(current_owner_role,state,updated_at desc);

commit;
