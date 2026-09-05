-- Contribution margin (MVP_EXECUTION_PLAN.md backlog #13) had nothing to compute a real dollar
-- figure from: service_quote_lines recorded the customer-facing unit_amount_minor and a
-- categorical revenue_recognition, but never what a 'net' line's merchant is actually owed. This
-- adds that missing piece -- nullable, since real cost data may not always be known at quote
-- time, and only meaningful for 'net' lines (a 'gross' line's margin is its full amount by
-- definition; a 'pass_through' line's margin is zero by definition).
alter table service_quote_lines add column if not exists merchant_cost_minor bigint check (merchant_cost_minor is null or merchant_cost_minor >= 0);
