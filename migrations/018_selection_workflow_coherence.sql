-- Align provider selection authority with the case workflow.
-- Customer choice, dealer-controlled choice, auto-dispatch and ops override
-- all converge on the same provider_pending handoff once a provider is selected.

insert into case_transition_rules(from_state,to_state,allowed_roles,terminal)
values('provider_selection','provider_pending',array['customer','partner','admin'],false)
on conflict(from_state,to_state) do update
set allowed_roles=excluded.allowed_roles,
    terminal=excluded.terminal;
