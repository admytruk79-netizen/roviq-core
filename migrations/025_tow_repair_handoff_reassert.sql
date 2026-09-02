-- Production's case_transition_rules row for (tow_in_progress -> repair_in_progress) was
-- still {tow,admin} instead of the {partner,admin} migration 023 sets, so a partner
-- accepting a tow-in-progress case's offer silently no-ops (transitionCase throws
-- transition_forbidden, which src/http/routes/partners.ts's respond handler swallows by
-- design) -- the case is stuck at tow_in_progress forever and every "Accept work" looks
-- like it succeeded. Verified locally: with the rule reverted to {tow,admin}, the exact
-- production symptom reproduces (200 response, unchanged state); with it corrected, the
-- transition goes through. Re-run 023's upsert here, idempotently, as its own migration so
-- every environment converges regardless of why the first application didn't take.
insert into case_transition_rules(from_state,to_state,allowed_roles,terminal)
values ('tow_in_progress','repair_in_progress',array['partner','admin'],false)
on conflict(from_state,to_state) do update
set allowed_roles = excluded.allowed_roles,
    terminal = excluded.terminal;
