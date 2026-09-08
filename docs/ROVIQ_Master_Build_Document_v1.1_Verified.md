# ROVIQ Master Build Document v1.1 — Verified

**Status:** Internal implementation authority  
**Scope:** ROVIQ Core, Maintenance, ROVIQ Connect, ROVIQ Shop OS, role portals, operations and pilot readiness  
**Verification basis:** PR #28 / `integrate-live-capacity-shop-os`, current migrations and services, successful CI before the canonical-table coherence correction  
**Relationship to v1.0:** This revision incorporates the architecture and delivery requirements of v1.0 and supersedes it where this document is more specific.

## 1. Product and architecture authority

ROVIQ is a controlled automotive service-coordination layer built around one reusable ROVIQ Core. Maintenance is the first commercial domain. Fastify Core owns business rules and canonical mutation authority; PostgreSQL is the system of record; Cloudflare protects/exposes routes and may execute edge/AI functions but does not independently own canonical business state.

One durable Service Case persists across the customer journey. Role applications expose authorized projections of that case. Rules and eligibility execute before ranking. Missing ownership, capability, authorization, required constraints or trustworthy synchronization fails closed. Partner isolation is strict.

## 2. Partner operating model

- **ROVIQ Connect:** synchronizes permitted operational signals from existing DMS/SMS/shop-management/scheduling/dispatch systems.
- **ROVIQ Shop OS:** supplies native scheduling, appointments and resource capacity when the partner does not have an adequate operating system.
- **Bridge Mode:** temporary import/calendar/admin/manual fallback. Bridge data must carry freshness and verification state and may never silently masquerade as synchronized live capacity.

Every external source is normalized before Core uses it. Core must never route directly against a vendor-specific schema.

## 3. Canonical platform primitives

The build follows one-authority-per-concept discipline:

- `service_cases` is the canonical case record.
- `events` is the canonical case/platform event stream.
- `notification_outbox` is the canonical communication-delivery workflow.
- `ledger_entries` is the canonical financial ledger.
- `case_exceptions` is the canonical exception record.
- partner-system connections/external references map outside systems into ROVIQ canonical records.

Migration 014 was corrected during verification so it evolves these existing primitives instead of creating competing event, communication or financial tables.

## 4. Serviceability before ranking

An open calendar slot is not sufficient. Core evaluates a serviceability window from location capacity, appropriate resource/capability, parts readiness where required, mobility/destination readiness where required, customer timing/approval constraints and trustworthy synchronization state.

A deterministic serviceability evaluator exists and fails closed on missing/exhausted/blocked capacity, degraded/failed synchronization, unknown/blocked required constraints and unauthorized manual capacity. Stale capacity may be held only when explicitly allowed and is not confirmable.

**Remaining build requirement:** wire the evaluator into routing, hold and appointment-confirmation paths so no downstream workflow can bypass it.

## 5. Unified Service Case lifecycle

Target lifecycle:

`intake -> triage -> serviceability_check -> capacity_discovery -> held -> confirmed -> transport_planned -> arrived -> diagnosis_or_ro_linked -> approval_required -> authorized -> work_in_progress -> quality_check -> ready -> return_planned -> completed`

Terminal/exception outcomes include `cancelled`, `no_show`, `unable_to_service`, and `expired`.

Existing case transitions, plans, events, deadlines and access policies provide a substantial foundation. The target lifecycle must be reconciled with the existing transition table and portal labels without breaking in-flight cases.

## 6. Actor projections

- **Customer:** vehicle/VIN history, case timeline, appointment, approvals, mobility, estimates/receipts, preferences and follow-up.
- **Diagnostic:** structured evidence, findings, confidence/limitations, category recommendation, escalation and case handoff.
- **Shop/dealership:** schedule, bays/technicians/resources, capability, blackouts, overflow/waitlist, no-shows, RO reference and live capacity.
- **Parts:** requirement state from identified through ready/unavailable, attached to the Service Case and projected into serviceability.
- **Tow/valet/mobility:** authorized movement context, availability, destination readiness, acceptance, ETA and proof of completion.
- **ROVIQ operations:** active cases, exceptions, connector health, stale capacity, partner performance, reconciliation and auditable interventions.

## 7. Exception Engine

Exceptions are first-class case records with severity, owner, due date/SLA, state, related case/resource/connection, remediation history and resolution code. Exception assignment/state changes and their case audit events must be atomic. The reviewed implementation now uses one database transaction for both mutation and event insertion.

Minimum exception classes include connector outage, stale/degraded capacity, external conflict/double-book, no-show, resource unavailable, partner rejection, transport cancellation, parts delay, diagnostic escalation and payment failure.

## 8. Communications and finance

Case notifications originate from canonical events and use `notification_outbox`; role-sensitive templates and delivery state remain auditable. Internal/competitor-sensitive state never leaks into unauthorized projections.

All charges, provider payouts, ROVIQ revenue, refunds, processing/support costs and adjustments are recorded through `ledger_entries` and linked to the Service Case. Real contribution margin may only be reported when those underlying entries are actually populated; no assumed take rate is substituted for missing data.

## 9. Partner administration and operations

Partner operating profiles include organization/location, capabilities, territories, onboarding state, integration mode, commercial rules and credential/compliance state where applicable. Complete production operation also requires named users/scopes, connection health, credential review/revocation and an internal operations view for stale capacity, connector errors, exception SLA/ownership and reconciliation.

## 10. Analytics and pilot instrumentation

Minimum evidence includes demand by geography/category, eligible-capacity rate, fill/acceptance, time to appointment/arrival/completion, utilization, cancellation/no-show rate, exception rate/resolution time, synchronization freshness/health, partner SLA performance, repeat use and case-level economics.

Pilot assumptions remain hypotheses until measured.

## 11. Build verification status

| Build area | Status | Verification finding |
|---|---|---|
| Canonical Core/PostgreSQL authority | VERIFIED | Existing canonical event, notification and ledger primitives remain authoritative. |
| ROVIQ Connect / normalized capacity | VERIFIED | Partner connection, external reference, resource/capacity and sync foundation exists. |
| Bridge freshness/verification | VERIFIED | Bridge data ages from `importedAt`; manual verification is explicit. |
| Capacity input validation | VERIFIED | Non-finite, fractional and negative quantities are rejected. |
| Serviceability evaluator | PARTIAL | Service and tests exist; end-to-end routing/confirmation wiring remains. |
| Unified Service Case lifecycle | PARTIAL | Strong foundation exists; expanded lifecycle not yet fully encoded. |
| Exception Engine | VERIFIED | Assignment/state/remediation/admin flow exists and mutation + audit event are atomic. |
| Customer vehicle ownership | PARTIAL | Schema exists; customer CRUD/history workflow remains. |
| Shop OS operating workflow | PARTIAL | Capacity/appointment model exists; full operating UI/workflows remain. |
| Parts as serviceability input | PARTIAL | Parts systems exist; automatic constraint projection remains. |
| Mobility as serviceability input | PARTIAL | Transport/mobility systems exist; combined gating remains. |
| Notifications | PARTIAL | Canonical outbox exists; new event-to-template orchestration remains. |
| Financial reconciliation | PARTIAL | Canonical ledger exists; complete case economics posting remains. |
| Partner admin / credential health | PARTIAL | Profile foundation exists; full access/health/revocation workflow remains. |
| Ops console | PARTIAL | Ops portal/admin APIs exist; v1.1 health/SLA/reconciliation views remain. |
| Pilot analytics | PARTIAL | Existing case metrics exist; full live-capacity/economic evidence remains. |
| CI/release gate | VERIFIED | Reviewed head passed fresh migrations, Core tests/build, Worker validation and portal builds. |

## 12. Lunaria-derived operating principles adapted to ROVIQ

These are process/product-governance principles, not Lunaria domain content.

### 12.1 Controlling-document register
Maintain version, status, owner and approval state for the Master Build Document, Platform Technical Specification, Data Architecture, security/privacy controls, integration specification, QA matrix, pilot plan, commercial assumptions, actor decks and operations runbook. Superseded documents remain identifiable as historical versions.

### 12.2 Explicit product boundary and change control
Capabilities are marked `pilot`, `production-required`, `later` or `out of scope`. A new actor, integration class, canonical data model, payment model or major workflow is an architecture/scope change. It requires written impact analysis covering schema, security, commercial assumptions, schedule, migration, rollback and testing before implementation.

### 12.3 Account ownership and individual scoped access
Production domains, accounts, billing relationships and recovery methods remain owned by the responsible ROVIQ/partner entity. Collaborators and integrations receive named, least-privilege, revocable access; shared passwords are prohibited. Access is reviewed at pilot approval, launch and handover.

### 12.4 Mock/placeholder discipline
Synthetic capacity, demo partner data, test credentials and AI-generated placeholder material remain visibly identified. No placeholder becomes production truth by convenience or default.

### 12.5 Data provenance and permission
Material external signals retain source connection, external reference, timestamp/freshness and authorization context. Customer evidence/uploads retain appropriate permission/provenance metadata. Unknown provenance fails closed where the information could affect routing, safety, money or customer promises.

### 12.6 AI authority boundary
AI operates only within explicit shadow/advisory/assisted authority. It cannot silently become verified diagnostic, routing, financial or safety truth. Model/provider use is reviewed for privacy, licensing, data handling and operational risk. Human/systems authority remains explicit.

### 12.7 Primary path plus safe fallback
Live integration is preferred, but degraded/manual operation is explicit, observable and reversible. A fallback never presents itself as live synchronized truth.

### 12.8 Accessible conventional route
No essential customer/partner task depends solely on animation, hover, drag, color, precision pointing or rapid timing. Interfaces provide readable text, predictable labels, visible focus, adequate touch targets, reduced-motion behavior where relevant, clear status, next action, back/exit and recovery paths.

### 12.9 Critical-first performance
Operationally critical case status, safety/authorization prompts, next action and serviceability load before decorative, analytic or noncritical content. Heavy media/embeds cannot delay operational action.

### 12.10 Portability and vendor exit
Avoid irreversible vendor lock-in. Canonical ROVIQ data remains exportable. Connector/vendor dependencies, renewal costs, credential ownership, backup/export procedures and replacement paths are documented.

### 12.11 Dependency-aware scheduling
Pilot/launch dates depend on partner access, third-party APIs, legal/commercial approvals and required data. Dependencies are explicit; a launch date is not considered committed until required inputs are available.

### 12.12 Formal stage gates
Use gates for: architecture/scope approval; partner data-contract and credential lock; integration sandbox; operational beta; security/privacy/accessibility/performance QA; pilot launch; evidence review.

### 12.13 Handover and recoverability
Every production system has a named owner, 2FA/recovery record, backup/export procedure, rollback instruction, incident contact and explicit post-handover access decision.

### 12.14 Canonical object reuse
One Service Case is projected to authorized actors. One event stream, one notification outbox and one financial ledger are reused rather than copied into parallel per-role/per-feature records.

## 13. Acceptance gates

A release is ready only when the corresponding gates pass: architecture, data/migrations, integration, serviceability, role isolation, exception recovery, financial reconciliation, operations observability, security/privacy, accessibility/performance and pilot evidence capture.

## 14. Immediate alignment backlog

1. Wire `evaluateServiceability` into routing/hold/confirmation.
2. Reconcile the v1.1 Service Case lifecycle with `case_transition_rules` and portal labels.
3. Project parts and mobility/destination readiness automatically into case constraints.
4. Complete partner onboarding, integration-health, access-review and credential-revocation workflows.
5. Complete Ops views for connector health, stale/degraded capacity, exception SLA/ownership and reconciliation.
6. Finish canonical event-driven notification templates and delivery projection.
7. Post complete case economics to `ledger_entries` for evidence-based contribution margin.
8. Add pilot evidence capture for accessibility, privacy, performance, data provenance, backup/export and handover readiness.

## 15. Pilot-ready definition

ROVIQ is pilot-ready only when a real Service Case can traverse intake, eligibility, live serviceability, confirmation, any required diagnostics/parts/mobility, completion, notification and financial reconciliation through canonical tables; no role can bypass authorization; stale/degraded/placeholder signals are visibly bounded; exceptions are recoverable and auditable; connector and credential health are observable; and the pilot produces required operational, accessibility, privacy, performance and economic evidence without manual reconstruction.
