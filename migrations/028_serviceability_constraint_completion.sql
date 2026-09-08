-- ROVIQ Core migration 028
-- Complete the canonical serviceability constraint vocabulary for transport readiness.

begin;

alter table case_constraints drop constraint if exists case_constraints_constraint_type_check;
alter table case_constraints
  add constraint case_constraints_constraint_type_check
  check (constraint_type in ('customer_time','resource','capability','parts','mobility','approval','transport','other'));

commit;
