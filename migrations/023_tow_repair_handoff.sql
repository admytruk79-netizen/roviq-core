-- Allow a repair partner that already has case access (for example through an accepted
-- provider offer) to acknowledge vehicle delivery and begin repair directly after tow.
-- transitionCase still enforces case access before this rule is evaluated, so an
-- unrelated partner cannot claim a tow-in-progress case.
insert into case_transition_rules(from_state,to_state,allowed_roles,terminal)
values ('tow_in_progress','repair_in_progress',array['partner','admin'],false)
on conflict(from_state,to_state) do update
set allowed_roles = excluded.allowed_roles,
    terminal = excluded.terminal;
