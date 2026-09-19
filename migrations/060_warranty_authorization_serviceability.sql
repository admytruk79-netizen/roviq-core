-- ROVIQ Core migration 060
-- Project warranty / repair-authorization requirements into the canonical
-- serviceability constraint vocabulary used by routing, holds and confirmation.

begin;

alter table case_constraints drop constraint if exists case_constraints_constraint_type_check;
alter table case_constraints
  add constraint case_constraints_constraint_type_check
  check (constraint_type in (
    'customer_time','resource','capability','parts','mobility','approval',
    'authorization','transport','other'
  ));

commit;
