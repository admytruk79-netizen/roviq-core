-- ROVIQ Core migration 069
-- Align the canonical constraint vocabulary with serviceability/provider readiness.

begin;

alter table case_constraints
  drop constraint if exists case_constraints_constraint_type_check;

alter table case_constraints
  add constraint case_constraints_constraint_type_check
  check (constraint_type in (
    'customer_time','resource','capability','parts','mobility','approval',
    'authorization','transport','provider','other'
  ));

commit;
