# ROVIQ Production Readiness Execution Plan

This is the standing execution plan for taking ROVIQ from hardening to controlled production readiness. It complements `PRODUCTION_NIELSEN_CHECKLIST.md` and should be executed in order unless a newly discovered correctness or security blocker takes priority.

## 1. Finish Shop OS hardening

- Complete modular decomposition around scheduling lifecycle, resource/capacity locking, serviceability, appointment persistence/events, and capacity/read models.
- Keep the global scheduling lock order explicit and consistent: service case -> appointment -> resource -> capacity.
- Keep serviceability and scheduling reads read-only with respect to unrelated operational projections.
- Revalidate resource and connector readiness under the same transaction for state-changing actions.
- Keep recovery-source validation explicit at the service boundary and return stable conflict errors.
- Remove arbitrary appointment-choice horizons where they can hide valid future capacity.
- Add real PostgreSQL concurrency tests for booking, rescheduling, approvals, deferred service, resource state changes, and capacity contention.

## 2. Finish automatic constraint ownership

- Each domain mutation owns only its focused projection refresh.
- Serviceability and scheduling paths consume projections rather than broadly rebuilding them.
- Add fail-closed coverage for parts, mobility, transport, approval, provider capability/readiness, and scheduling dependencies.
- Confirm that absent/non-applicable dependencies do not block and that customer-time does not circularly block initial holds.

## 3. Production-grade CI and deployment

- Deterministic `npm ci` installs only.
- Explicit least-privilege workflow permissions.
- Concurrency cancellation for superseded runs.
- Job timeouts and dependency caching.
- Fresh-database migration acceptance tests.
- Core tests/build plus all portal builds on every PR.
- Exact-head verification before declaring CI green or merge-ready.
- Normalize supported Node/tool versions across root and portals.

## 4. Partner integration health and Ops console

- Show connector status, sync freshness/lag, failures, retries, and recovery actions.
- Surface stale/degraded capacity and operational blockers.
- Make exception ownership and SLA visible.
- Expose enough audit/provenance information for operators to diagnose a blocked case without direct database access.

## 5. Notification delivery truth

- Keep `notification_outbox` canonical.
- Add provider delivery adapters, retries/backoff, deduplication, delivery status, and failure recovery.
- Distinguish queued, retrying, delivered, and failed states in authorized operational views.

## 6. Financial truth and payment integration

- Implement the real payment provider path rather than treating internal payment records as proof of settlement.
- Add webhook signature verification, idempotent event processing, replay protection, refunds/disputes, and reconciliation.
- Map payment events into canonical ledger entries and case-level economics.
- Add Connect/payout reconciliation only if required by the live ROVIQ partner-payment model.

## 7. Security and reliability pass

- Rate limiting and abuse controls.
- Session/token and tenant-isolation review.
- Secret-handling review.
- Structured logs and correlation IDs.
- Readiness/health checks and actionable alerting.
- Backup/restore evidence and recovery procedures.
- Migration failure/rollback strategy.

## 8. Accessibility and performance evidence

- Run the Nielsen gate across Customer, Partner/Shop OS, Diagnostic, Parts, Tow/Valet, and Ops.
- Keyboard navigation, focus management, labels/live regions, loading/error/empty states, and mobile layouts.
- Capture performance and accessibility evidence rather than relying only on visual inspection.

## 9. Real connector and real Shop OS pilot

- Validate at least one real partner integration or real ROVIQ-Native Shop OS location.
- Exercise scheduling, routing, repair orders, parts, transport, notifications, and financial reconciliation with operational data.
- Manual/Bridge operation must remain visibly degraded fallback, not the primary path.

## 10. Adversarial end-to-end testing

Test at minimum:

- Concurrent booking/rescheduling.
- Duplicate/replayed requests and webhooks.
- Stale capacity and connector outages.
- Provider loss, inactive providers, and reassignment.
- Conflicting external updates.
- Parts delay and transport/valet cancellation.
- Notification failure/retry.
- Payment failure/refund/dispute.
- Resource/technician failure.
- Customer no-show.
- Database restart/recovery.
- Tenant and role-boundary abuse attempts.

## 11. Controlled pilot gate

Do not declare production readiness until the supported pilot scope can operate without a parallel spreadsheet, calendar, text thread, or paper workaround; material actions are auditable; failures degrade visibly; backups/recovery are proven; and operational, notification, financial, accessibility, privacy, and performance evidence can be produced from the system itself.

## Standing rule

A newly discovered correctness, concurrency, tenant-isolation, security, financial, or data-integrity issue blocks progression until fixed and regression-tested. Green CI by itself is not production readiness.
