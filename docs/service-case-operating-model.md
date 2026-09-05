# ROVIQ unified Service Case operating model

Status: implementation contract for Core.

ROVIQ coordinates one durable Service Case across every authorized actor. Portals are projections of the case; they do not create independent jobs.

## Lifecycle
`intake -> triage -> serviceability_check -> capacity_discovery -> held -> confirmed -> transport_planned -> arrived -> diagnosis_or_ro_linked -> approval_required -> authorized -> work_in_progress -> quality_check -> ready -> return_planned -> completed`

Terminal/exception states: `cancelled`, `no_show`, `unable_to_service`, `expired`.

Every transition records actor, role, timestamp, source system, correlation/idempotency key and an append-only case event. External systems retain their own IDs through `partner_external_refs`.

## Serviceability window
A routable appointment is not merely an open calendar slot. Core must establish a serviceability window from:

1. shop/location availability;
2. appropriate technician/bay/resource capability;
3. parts readiness or an explicit parts-independent service category;
4. required tow/valet/loaner/mobility capacity;
5. customer timing/approval constraints;
6. current, sufficiently trustworthy synchronization state.

Rules and eligibility execute before ranking. Stale or degraded signals cannot silently become confirmed capacity.

## Actor projections
- Customer: vehicle, case timeline, approvals, appointment, mobility, estimates/receipts, communication preferences.
- Diagnostic: structured intake/evidence, findings, limitations/confidence, recommended service category, escalation and handoff.
- Shop/dealership: appointment board, capabilities, resource windows, RO linkage, overflow, waitlist and exceptions.
- Parts: requirement, sourcing, order, ETA, received/readiness state.
- Tow/valet/mobility: eligible movement context, acceptance, ETA, evidence and completion.
- ROVIQ operations: complete authorized case timeline, sync health, exceptions, interventions, reconciliation and audit history.

Partner isolation remains strict. A projection exposes only information required for the authorized role and case.

## Exception engine
Exceptions are first-class case records, not ad-hoc error strings. Minimum classes: stale capacity, double-book/conflict, connector outage, customer late/no-show, resource unavailable, partner rejection, transport cancellation, parts delay, diagnostic escalation, payment failure and external-update conflict.

Each exception has severity, owner, SLA/due time, current status, resolution code, related case/resource/connection and audit history. Automated remediation may retry/re-route/hold; destructive or financially material actions require the appropriate authorization.

## Communications
Notifications are emitted from case events, not portal-specific code. Channels can include in-app, push, SMS or email according to customer/partner preferences and consent. Delivery state is auditable. Sensitive/internal events never leak into customer or competitor projections.

## Money and reconciliation
Charges, provider payouts, ROVIQ coordination revenue, refunds, cancellations and adjustments attach to the Service Case. This enables case-level gross revenue, provider cost, processing/refund/support adjustments and contribution margin without taking a percentage of shop/dealership labor revenue.

## Partner administration
Core needs partner locations, users/roles, capabilities, territories, credentials/compliance status where applicable, commercial rules, integration mode, read/write scopes, connection health and onboarding state.

## ROVIQ operations console
The internal console must surface active cases, exceptions, stale/degraded capacity, connector health, partner performance, payouts/reconciliation and auditable manual interventions. Manual intervention changes canonical state only through Core commands/events.

## Analytics
Minimum operational measures: demand, eligible-capacity rate, fill rate, acceptance, time-to-appointment, time-to-arrival, time-to-completion, utilization, cancellations/no-shows, exception rate, sync freshness/health, partner SLA performance, repeat use and case-level contribution margin.

## Delivery sequence
1. Schema/event contracts and lifecycle enforcement.
2. Serviceability evaluation across capacity/resources/parts/mobility/customer constraints.
3. Exception records and remediation commands.
4. Partner admin + integration health.
5. Customer/diagnostic/shop/parts/mobility projections.
6. Operations console.
7. Event-driven notifications.
8. Case financial ledger/reconciliation.
9. Analytics and pilot instrumentation.

All new endpoints must remain fail-closed, role-scoped, idempotent where mutation can be retried, and auditable.