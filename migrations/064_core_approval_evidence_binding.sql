-- Bind policy evaluation to explicit, version-matched approval evidence.
-- Cases opt in by setting constraints.customerApprovalRequired=true.
insert into core_policy_rules(
  policy_code,action,effect,priority,case_type,from_state,to_state,actor_role,predicate,reason
)
values(
  'case_complete_requires_current_customer_approval',
  'case.transition',
  'require_review',
  1000,
  null,
  null,
  'completed',
  null,
  '{"case.constraints.customerApprovalRequired":{"eq":true},"approval.valid":{"neq":true}}'::jsonb,
  'Current customer approval is required before this Case can be completed.'
)
on conflict(policy_code) do update set
  action=excluded.action,
  effect=excluded.effect,
  priority=excluded.priority,
  to_state=excluded.to_state,
  predicate=excluded.predicate,
  reason=excluded.reason,
  enabled=true,
  updated_at=now();
