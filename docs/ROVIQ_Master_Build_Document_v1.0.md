# ROVIQ Master Build Document v1.0

**Status:** Internal implementation authority  
**Scope:** ROVIQ Core, Maintenance, ROVIQ Connect, ROVIQ Shop OS, actor portals, operations, pilot readiness  
**Prepared:** September 2026

## 1. Purpose and authority
This is the controlling build document for ROVIQ implementation. It consolidates product architecture, canonical data, role projections, delivery gates, acceptance criteria, and pilot instrumentation. Where older documents conflict, the newest approved architecture and migrations prevail.

ROVIQ is not a referral directory. It is a controlled service-coordination layer built around one reusable ROVIQ Core. Maintenance is the first commercial domain. Local and Station may reuse shared primitives only after Maintenance proves repeatable coordination.

## 2. Non-negotiable architecture principles
- Fastify Core owns business rules, authorization and canonical state.
- Neon PostgreSQL is the system of record.
- Cloudflare protects/exposes routes and may execute edge/AI functions, but does not independently own canonical business state.
- One Service Case persists across the entire customer journey.
- Rules and eligibility execute before ranking.
- Missing ownership, assignment, capability, synchronization confidence or policy fails closed.
- Every material mutation is auditable and idempotent where retries are possible.
- Partner isolation is strict: competitors never receive raw queues, full capacity, pricing configuration, customer lists or private case data.
- Production routing consumes normalized live capacity, never raw third-party schemas or informal manual claims.
- Progressive delivery: enable only validated Maintenance capabilities; preserve future extension points without prematurely activating them.

## 3. Platform operating model
### 3.1 Partner adoption paths
**ROVIQ Connect** connects mature operators to existing DMS, SMS, shop-management, appointment, dispatch or scheduling systems. It synchronizes only authorized operational signals.

**ROVIQ Shop OS** provides native scheduling, bay/technician/resource capacity and appointment management for smaller or under-digitized partners.

**Bridge Mode** supports calendar sync, import, admin entry or manual verification as a transition/pilot fallback. It is not the intended production source of truth.

### 3.2 Canonical normalization
External systems map through partner-system connections, external references and integration events into canonical ROVIQ resources, capacity windows, appointments, cases and events. Core never routes directly against a vendor-specific schema.

## 4. Unified Service Case
Every participant operates on an authorized projection of one durable Service Case rather than creating disconnected jobs.

### 4.1 Lifecycle
`intake -> triage -> serviceability_check -> capacity_discovery -> held -> confirmed -> transport_planned -> arrived -> diagnosis_or_ro_linked -> approval_required -> authorized -> work_in_progress -> quality_check -> ready -> return_planned -> completed`

Terminal/exception states: `cancelled`, `no_show`, `unable_to_service`, `expired`.

Every transition records actor, role, timestamp, source, before/after state, correlation ID and idempotency key where applicable.

## 5. Serviceability rather than simple availability
Core evaluates a **serviceability window**, not merely an appointment slot. Confirmation requires:
1. location/shop availability;
2. appropriate technician/bay/resource capability;
3. parts readiness or explicit parts-independent service classification;
4. required tow/valet/loaner/mobility availability;
5. customer timing and approval constraints;
6. sufficiently current and trustworthy synchronization state.

Stale or degraded capacity may be displayed or held according to policy but cannot silently become confirmed production capacity.

## 6. Actor projections
### Customer
Vehicle garage/VIN, service history, preferred partners, case timeline, appointment, approvals, estimate/receipt state, mobility/tow status, communication preferences and post-service follow-up.

### Diagnostic
Structured intake, photos/video/evidence, findings, confidence/limitations, recommended service category, escalation and handoff into the Service Case.

### Shop / dealership
Appointment board, bays/technicians/resources, service capabilities, blackout periods, waitlist/overflow, cancellations/no-shows, RO reference, live capacity and capacity forecasting.

### Parts
Requirement identified, sourcing, ordered, ETA, received and ready state attached to the case. Parts readiness becomes a serviceability constraint.

### Tow / valet / mobility
Movement request, authorized context, availability, acceptance, ETA, operator assignment, pickup/drop-off evidence and completion. Mobility capacity coordinates with service capacity.

### ROVIQ operations
Full authorized case timeline, sync health, exceptions, partner performance, payouts/reconciliation and auditable manual intervention.

## 7. Customer ownership layer
Build a durable customer-vehicle relationship around `customer_vehicles` and Service Cases. The customer experience must preserve history rather than resetting on every request. Customer-visible state is derived from canonical records/events, never frontend-only flags.

## 8. Shop OS operating layer
ROVIQ Shop OS must include:
- location schedule and day/week board;
- bays, technicians and other resources;
- service capability mapping;
- capacity windows and blackout periods;
- appointment hold/confirm/reschedule/cancel/no-show flows;
- overflow/waitlist controls;
- pause/resume and degraded mode;
- RO/external reference fields;
- partner-level visibility and role permissions.

## 9. Diagnostic workflow
Diagnostic actors do not exist as a standalone silo. Diagnostic evidence and findings belong to the Service Case. Required fields include evidence, observed symptoms, confidence/limitations, recommended category, escalation reason, handoff target and confirmation outcome.

## 10. Parts readiness
Parts are modeled as case constraints. A required part progresses through `identified -> sourcing -> ordered -> eta_known -> received -> ready`, with unavailable/cancelled outcomes. Routing must not promise a repair window that contradicts known parts readiness unless policy explicitly allows pre-diagnostic or parts-independent work.

## 11. Mobility and movement
Tow, valet, pickup/return and loaner resources are capacity inputs. A movement should know destination readiness and the relevant service window before dispatch whenever possible. Completion proof feeds the same case timeline and partner performance history.

## 12. Exception Engine
Exceptions are first-class records, not scattered log strings. Minimum exception types:
- stale/degraded capacity;
- connector outage;
- double-book or external conflict;
- customer late/no-show;
- technician/resource unavailable;
- shop rejection;
- tow/valet cancellation;
- parts delay/unavailable;
- diagnostic escalation;
- payment failure;
- external update conflict.

Each exception has severity, owner, SLA/due time, state, related case/resource/connection, remediation attempt history and resolution code. Automatic retries/rerouting must remain policy-bound and auditable.

## 13. Notifications and communication
Notifications derive from case events. Role-specific templates may use in-app, push, SMS or email according to consent/preferences. Delivery state is auditable. Internal or competitor-sensitive events are never exposed in customer or partner projections.

## 14. Commercial and financial ledger
Charges, provider payouts, ROVIQ revenue, processing cost, refunds, cancellations, adjustments and support cost attach to the Service Case. This enables case-level revenue and contribution margin while preserving the business rule that ROVIQ does not take a percentage of dealership/shop labor revenue.

## 15. Partner administration
Partner operating profiles include organization/location, users/roles, capabilities, territories, credential/compliance state where applicable, commercial rules, integration mode, read/write scopes, onboarding status and connection health.

## 16. ROVIQ operations console
The internal console must expose:
- active/blocked cases;
- open exceptions;
- stale/degraded capacity;
- connector status and sync errors;
- partner SLA and acceptance/completion performance;
- financial reconciliation and payout status;
- case search and timeline;
- permissioned manual intervention with audit history.

Manual operations are commands through Core; the console may not mutate hidden state locally.

## 17. Analytics and pilot instrumentation
Minimum metrics:
- demand by geography/service category;
- eligible-capacity rate;
- fill/acceptance rate;
- time to appointment/arrival/completion;
- technician/location utilization;
- cancellations and no-shows;
- exception rate and resolution time;
- synchronization freshness and connector health;
- partner SLA performance;
- repeat customers;
- case revenue, provider cost and contribution margin.

Pilot assumptions must remain explicitly labeled as hypotheses until measured.

## 18. Security, privacy and operational integrity
- Least-privilege roles and fail-closed authorization.
- Secrets only in environment/platform settings, never repository source.
- MFA for privileged operator/admin access where available.
- Input validation, rate limiting, bot/abuse controls where appropriate.
- Minimize personal information and role-scope all projections.
- Immutable/auditable events for state changes.
- Recoverable database/source/deployment history.
- No public document exposes routing weights, private schemas, partner economics or non-public APIs.

## 19. Environment and release workflow
### Development
Local implementation, migrations, unit and integration tests.

### Preview / staging
Protected deployment with production-like data contracts and synthetic/test data. Used for product review, partner-integration validation and acceptance testing.

### Production
Approved deployment only after required gates pass. Production release must be reversible to a prior known-good revision.

Changes flow through version control, pull request/review, automated tests, preview deployment, acceptance checks and controlled production release.

## 20. Acceptance gates
A release is not ready because the UI renders. The corresponding gate must pass.

### Architecture gate
Canonical state ownership, authorization and integration boundaries are preserved.

### Data gate
Migrations are forward-safe, indexed appropriately and compatible with rollback/recovery procedures.

### Integration gate
Inbound/outbound sync, idempotency, external IDs, webhook/poll fallback, stale/degraded handling and conflict rules pass tests.

### Serviceability gate
Core rejects impossible combinations and does not confirm against stale/insufficient capacity.

### Role gate
Every portal sees only its authorized projection and required actions.

### Exception gate
Known failure scenarios create/remediate auditable exceptions rather than silently corrupting state.

### Financial gate
Charges/payouts/refunds/reconciliation balance at case level.

### Operations gate
ROVIQ staff can detect and safely intervene in blocked cases.

### Pilot gate
Metrics needed to validate completion, utilization, retention, synchronization and contribution are captured.

## 21. QA matrix
Test at minimum:
- happy-path case from intake through completion;
- integrated partner path;
- Shop OS partner path;
- Bridge fallback path;
- stale connector;
- webhook replay/duplicate mutation;
- conflicting external update;
- double-book attempt;
- resource/technician failure;
- parts delay;
- tow/valet cancellation;
- customer no-show;
- payment failure/refund;
- role-access violation;
- cross-partner data isolation;
- case recovery after retry/reassignment.

## 22. Delivery sequence
1. Schema/event contracts and lifecycle enforcement.
2. Serviceability evaluator.
3. Exception Engine and remediation commands.
4. Partner admin and integration health.
5. Customer, diagnostic, shop, parts and mobility projections.
6. ROVIQ operations console.
7. Event-driven notifications.
8. Case financial ledger/reconciliation.
9. Analytics and pilot instrumentation.
10. One real connector and one Shop OS pilot location.
11. End-to-end production hardening.
12. 60–90 day controlled pilot and evidence review.

## 23. Lunaria-derived delivery principles adapted to ROVIQ
The following are process/design principles adapted from the Lunaria planning documents, not product-domain features copied into ROVIQ:

### A. Controlling-document register
Lunaria uses a document register to identify controlling documents, order and approval status. ROVIQ should maintain the same discipline: Business Plan, Master Build Document, Master Technical Specification, Data Architecture, Security/Privacy controls, actor decks, pilot SOW/agreement, integration checklist and handover/runbook each receive version/status/owner fields.

### B. Explicit product boundary
Lunaria separates Phase 1 from deferred functionality. ROVIQ should likewise mark every capability as `pilot`, `production-required`, `later`, or `out of scope` to prevent architecture creep.

### C. Client/partner ownership and scoped access
Lunaria specifies client-owned source/hosting accounts and scoped collaborator access. ROVIQ should preserve clear ownership of partner credentials and external-system authorization, grant least-privilege scopes and make revocation straightforward.

### D. Primary path plus safe fallback
Lunaria requires conventional navigation alongside immersive navigation and reduced-motion/static alternatives. The corresponding ROVIQ principle is that automation/integration is the preferred path but a safe, visible degraded/manual fallback exists for outages and legacy partners. The fallback must never silently masquerade as live state.

### E. Predictability and orientation
Lunaria emphasizes predictable navigation state, focus order and visible escape routes. ROVIQ portals should likewise provide clear case status, next action, ownership, back/exit behavior and recovery paths instead of trapping users in ambiguous workflow states.

### F. Progressive enhancement and performance
Lunaria loads the essential experience first and defers nonessential effects. ROVIQ should load operationally critical case/status/action data first; analytics, decorative media and noncritical enhancements may load later.

### G. Accessibility and neuroinclusive clarity
Lunaria treats the visual metaphor as enhancement rather than the only route and uses readable text, strong contrast, reduced motion and predictable labels. ROVIQ should adopt the same interface baseline across customer and partner apps.

### H. Review, staging, acceptance and rollback
Lunaria explicitly defines development, preview/staging and production plus documented review and rollback. ROVIQ adopts the same release discipline, expanded with migration, integration, authorization and serviceability gates.

### I. Canonical object reused across views
Lunaria avoids duplicating one content item across multiple feeds. ROVIQ applies this much more strongly: one canonical Service Case appears as multiple authorized role projections, never duplicated case records per actor.

## 24. Documentation register for the build
1. Master Build Document — controlling implementation roadmap and gates.
2. Platform Master Technical Specification — architecture and domain specification.
3. Master Data Architecture — canonical entities, APIs, events and transaction rules.
4. Partner Integration + Shop OS specification — connectors, normalization, synchronization and degraded behavior.
5. Service Case Operating Model — lifecycle, serviceability and projections.
6. Security/Privacy/Authorization specification.
7. Operations Runbook — incidents, connector outages, retries, rollback and manual intervention.
8. QA/Acceptance Matrix — test cases and release gates.
9. Pilot Operations Plan — partners, scope, metrics, exception rules and 60–90 day measurement plan.
10. Commercial assumptions register — hypotheses versus validated values.
11. Actor presentation family — Investor, Dealership, Shop, Diagnostic, Parts, Tow/Valet and Customer as appropriate.

## 25. Definition of build complete for pilot
ROVIQ is pilot-ready when one customer case can traverse intake, eligibility, live serviceability, appointment, optional diagnostics/parts/mobility, completion and financial reconciliation while every actor sees only its authorized projection; connector/Shop OS health is observable; exceptions are recoverable; and the required pilot metrics are captured without manual reconstruction.
