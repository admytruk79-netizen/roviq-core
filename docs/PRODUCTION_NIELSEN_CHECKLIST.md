# ROVIQ Production + Nielsen Implementation Checklist

This document is the standing implementation checklist for ROVIQ productionization. It is derived from the controlling Master Build Document and Master Data Architecture, plus an explicit Nielsen usability acceptance gate.

Do not skip, reorder casually, or declare pilot/production readiness until the applicable items are implemented, tested, observable in the relevant portal, and evidenced.

## Production work — execute in order

### 1. Finish Shop OS scheduling/WIP operations
- Day/week scheduling.
- WIP board.
- Waitlist/no-show handling.
- Reschedule/cancellation recovery.
- Technician/bay/resource controls.

Acceptance intent: a shop must always know what is happening, who owns it, what is blocked, and what action is next.

Nielsen mapping: visibility of system status; user control and freedom; error prevention.

### 2. Complete repair-order workflow
- Estimate/repair-order presentation.
- Digital inspection evidence.
- Technician assignments and time.
- Deferred service.
- Customer continuity/history.

Acceptance intent: the workflow must look and behave like real automotive service operations rather than an abstract state machine.

Nielsen mapping: match between system and real world; recognition rather than recall; consistency and standards.

### 3. Finish automatic constraints
- Parts readiness -> case_constraints automatically.
- Mobility readiness -> case_constraints automatically.
- Destination readiness -> case_constraints automatically.
- Fail closed before confirmation/booking when required constraints are not ready.

Acceptance intent: users must not be able to schedule or confirm work that cannot actually proceed.

Nielsen mapping: error prevention.

### 4. Complete Partner integration-health UX
- Onboarding state.
- Connector health.
- Access review.
- Credential revocation.
- Connected / stale / degraded / disconnected states must be obvious.

Nielsen mapping: visibility of system status; user control; help users recognize, diagnose and recover from errors.

### 5. Complete ROVIQ Ops console
- Connector health.
- Stale/degraded capacity.
- Exception SLA and ownership.
- Financial reconciliation.
- Exception-first operational layout rather than a giant undifferentiated dashboard.

Nielsen mapping: visibility of system status; error recovery; flexibility and efficiency of use.

### 6. Complete notifications
- Event-driven templates.
- notification_outbox remains the canonical outbox.
- Delivery-status projection.
- Queued / delivered / failed / retrying states visible to authorized users where operationally relevant.

Nielsen mapping: visibility of system status and timely feedback.

### 7. Complete financial truth
- Post complete case economics to ledger_entries.
- Provider cost.
- ROVIQ revenue.
- Processing/support costs.
- Charges, payouts and refunds.
- Case-level reconciliation.
- Contribution margin measurable without assumptions.

Nielsen mapping: consistency and standards; error prevention.

### 8. Complete accessibility/performance/evidence gates
- Accessibility evidence.
- Privacy evidence.
- Performance evidence.
- Data provenance evidence.
- Backup/export procedures.
- Handover/recovery readiness.

Nielsen mapping: minimalist/predictable interaction, clear feedback, readable and accessible operational UI.

### 9. Validate one real connector + one real Shop OS pilot location
- ROVIQ Connect or ROVIQ Shop OS must be the real live operating path.
- Bridge/manual sync is only a visibly degraded fallback.
- Validate usability against the actual workflow, not only synthetic screens or fixtures.

### 10. Execute adversarial E2E testing
- Concurrent booking.
- Tenant isolation.
- Connector outage and recovery.
- Duplicate event/replay.
- Conflicting external update.
- Provider loss/reassignment.
- Payment failure/refund.
- Notification retry.
- Rollback/recovery.
- Resource/technician failure.
- Parts delay.
- Tow/valet cancellation.
- Customer no-show.

Nielsen mapping: error prevention; help users recognize, diagnose and recover from errors.

### 11. Run controlled pilot
- A ROVIQ-Native shop must be able to operate a complete service day for the supported pilot scope without a parallel spreadsheet, calendar, text-message thread or paper workaround.
- Appointments/resource holds must be concurrency-safe.
- WIP and ownership must be recoverable.
- Every material action must be auditable.
- Customer/vehicle/service history must be durable.
- Failures must degrade visibly.
- Exports/backups must exist.
- Completed cases must reconcile operational, notification and financial truth.
- Operational, accessibility, privacy, performance and economic evidence must be captured automatically rather than reconstructed manually.

## Architecture/UI constraint

Every frontend remains a thin, authorized projection of the same canonical Service Case.

- Customer: issue, vehicle, status, next step, approvals, ETA, provider when appropriate, simplified map.
- Partner/Shop OS: assigned demand, diagnostic summary, service scope, slot/capacity, parts/transport dependencies.
- Diagnostic: symptoms, task, findings, case location, handoff.
- Parts: required items, availability, ETA, fulfillment destination, case reference.
- Tow/Valet: pickup, destination, route, vehicle, handoff, ETA, dispatch status.
- Ops: active cases, exceptions, assignments, dependencies and network oversight within staff authorization.

No portal duplicates proprietary routing logic, transition authority, ranking weights, or another role's private operational data.

# Nielsen UX release gate

Every primary workflow in Customer, Partner/Shop OS, Diagnostic, Parts, Tow and Ops must pass all ten checks before pilot-readiness can be declared.

## 1. Visibility of system status
- Current case state is visible.
- Next action is visible.
- Current owner/assignee is visible when operationally relevant.
- Sync/connector state is visible when operationally relevant.
- Saving/loading/error/retry state is explicit.

## 2. Match between system and the real world
Use automotive-service language rather than internal state-machine terms.

Examples:
- Awaiting approval.
- Technician assigned.
- Parts delayed.
- Ready for pickup.

Do not expose internal codes such as capacity_sync_failed as primary user-facing language.

## 3. User control and freedom
- Back behavior is predictable.
- Cancel behavior is available where allowed.
- Recovery paths exist.
- No dead ends.
- Destructive actions require appropriate confirmation and provide recovery where technically possible.

## 4. Error prevention
- Disable impossible actions before submission.
- Explain why an action is unavailable.
- Prevent invalid state transitions, double booking, stale-capacity confirmation and impossible dependency combinations server-side as well as in UX.

## 5. Consistency and standards
Across portals, the same concepts must look and behave consistently:
- Status chips.
- Dates/times.
- Case references.
- Alerts.
- Confirmations.
- Error severity.
- Loading/saving states.

## 6. Recognition rather than recall
- Available actions remain visible.
- Required dependencies remain visible.
- Users should not need to remember information from a previous screen to decide what to do next.
- Critical context must travel with the task.

## 7. Flexibility and efficiency of use
- Ops and Shop OS expert users need low-click workflows.
- Keyboard-friendly interaction should be supported where appropriate on desktop operational surfaces.
- Expert speed must not clutter customer-facing experiences.

## 8. Aesthetic and minimalist design
- Primary action and active exception first.
- Operationally critical case data loads first.
- Secondary analytics/details use progressive disclosure.
- Decorative layers must never delay or compete with operational action.

## 9. Help users recognize, diagnose and recover from errors
Errors must identify:
- What happened.
- Operational consequence.
- What the user can do next.

Example: "Capacity data is 38 minutes stale — refresh connector or use verified manual fallback" rather than "capacity_sync_failed".

## 10. Help and documentation
- Use concise contextual help for unfamiliar concepts.
- Avoid requiring users to leave the task and read a large manual for normal operation.
- Recovery guidance belongs near the blocked action or exception.

# Readiness rule

Green CI alone does not satisfy this checklist.

Pilot-ready requires the relevant production items and all applicable Nielsen gates to be evidenced in real end-to-end operation.

Production-ready additionally requires the documented hardening, real connector/Shop OS operation, backups/recovery/handover, financial/notification truth, observability, and controlled-pilot evidence to be complete.