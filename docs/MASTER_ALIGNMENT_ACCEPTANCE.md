# ROVIQ Master Alignment & Acceptance Gate

**Status:** living implementation check for PR #28  
**Authority:** newest approved Master Build / Master Data Architecture, then newer approved migrations and implementation decisions where the Master explicitly permits them to supersede older wording.

## Product-wide UX acceptance rule

Every actor projection must be understandable by a first-time user without training. A user should understand the current state, ownership and next action within roughly ten seconds. Common work should require one or two obvious actions; raw UUIDs, database enums, internal state-machine vocabulary and duplicated backend concepts stay out of the primary workflow. Advanced controls remain available through progressive disclosure.

This rule is applied together with Nielsen usability heuristics: visible system status, real-world language, user control and recovery, consistency, error prevention, recognition over recall, efficient role workflows, minimalist primary surfaces, actionable errors and contextual help only when needed.

## Canonical architecture guardrails

- Fastify Core owns authorization, workflow transitions, routing policy and canonical operational state.
- Neon PostgreSQL remains the system of record for Core business state.
- Actor front ends are authorized projections of Core state; they do not own proprietary routing or hidden workflow state.
- ROVIQ Connect and Shop OS normalize operational capacity before Core serviceability/routing consumes it.
- ROVIQ Local remains a spatial/discovery substrate behind a constrained Core adapter. Local catalog/discovery data is not copied into Core as operational case truth.
- Material mutations are auditable, tenant scoped and fail closed when ownership, capability, assignment, policy or synchronization confidence is insufficient.

## Actor acceptance matrix

### Customer
- [x] Durable Service Case projection and customer-visible state.
- [x] Reduced navigation and hardened sign-out.
- [ ] Validate first-time-user service request through completion on deployed mobile portal.
- [ ] Accessibility and recovery-path acceptance evidence.

### Diagnostic
- [x] Accepted assignment is the dominant task.
- [x] Vehicle location and live technician GPS precede forms.
- [x] Day/Night map mode and explicit location state.
- [x] Human service labels replace raw demand enums and internal IDs in the normal workflow.
- [x] Finding and field-assessment evidence remain attached to the Service Case; Core remains the decision authority.
- [ ] Deployed mobile acceptance: assignment → travel → evidence → finding → handoff.

### Tow / Valet
- [x] Driver-style map-first workflow and canonical spatial handoff.
- [x] Explicit-dispatch destination overrides remain separate from canonical case destination.
- [x] Late canonical destination corrections propagate only to inherited active dispatches.
- [x] Dispatch ordering is independent of synchronization timestamps.
- [ ] Deployed field acceptance including poor-GPS recovery and full pickup/delivery evidence path.

### Partner / Dealership
- [x] Offers and accepted work are tenant scoped.
- [x] Capacity controls feed canonical Core capacity.
- [x] Shop OS daily workspace exposes appointments, resources and waitlist in one task-first view.
- [ ] Replace remaining raw case/demand IDs in legacy Partner queue details with human context.
- [ ] Validate dealership advisor workflow without a parallel spreadsheet/calendar for supported pilot scope.

### Shop OS
- [x] Canonical resources, capacity windows, reservations and appointments.
- [x] Hold/confirm/reschedule/cancel/no-show lifecycle.
- [x] Day board and waitlist/overflow controls.
- [x] Repair orders, estimates, approvals, parts readiness and deferred service.
- [x] DVI evidence, work items, technician assignment/time and QC flow.
- [x] Completion and repair-order reconciliation foundations.
- [ ] Expose complete advisor/technician workflow through the production UI, not API-only surfaces.
- [ ] Degraded-mode controls and visibility in the Shop OS primary workspace.
- [ ] Export/backup/restore acceptance evidence.
- [ ] Complete service-day acceptance without parallel tools.

### ROVIQ Ops
- [x] Action-first case summary is now the primary case view.
- [x] Existing detailed controls remain available under progressive disclosure.
- [x] Exception queue uses tenant scope rather than being globally blocked for actor-backed admins.
- [ ] Complete top-level operational views for connector health, stale/degraded capacity, exception SLA and financial reconciliation.
- [ ] Remove remaining raw internal IDs from legacy advanced controls where human labels are available.
- [ ] Verify every manual intervention is a Core command and auditable.

### Parts
- [x] Parts orders/readiness attach to canonical case/repair-order context.
- [ ] Apply the same zero-training UX acceptance pass to the production Parts portal.
- [ ] Validate parts delay/unavailable exception recovery in the service-day acceptance run.

## ROVIQ Local → Core boundary

Current Core integration is intentionally an adapter, not a data-model merge.

- `/api/local/route` proxies constrained route computation through Core.
- `/api/local/places` exposes approved Local discovery results through Core with validated spatial/category inputs.
- `/api/local/health` exposes adapter health to authenticated Core actors.
- `ROVIQ_LOCAL_BASE_URL` may override the Local deployment endpoint; no Local operational state is persisted in Core by this adapter.

Next Local integration increment: move existing role portals that require route/discovery data from direct Local API calls toward the Core adapter where doing so improves authorization/observability, while map rendering can remain a Local presentation resource until a shared map package is justified.

## Service-day acceptance scenario

A pilot candidate does not pass merely because individual APIs work. Run one controlled scenario with evidence at every boundary:

1. Customer intake creates one durable Service Case and location context.
2. Eligibility/serviceability evaluates live normalized capacity and fails closed on stale/degraded inputs.
3. Required diagnostic or mobility actor receives only its authorized projection and completes the handoff.
4. Shop receives/accepts the case; appointment/resource capacity is held and confirmed without overbooking.
5. Advisor creates/links the RO and estimate; customer approval is captured canonically.
6. DVI evidence, parts readiness, technician assignment/time and WIP progress on the same case/RO.
7. QC and completion close operational work only when completion guards pass.
8. Notifications are emitted from canonical events and retry safely.
9. Financial truth reconciles charge/GMV, provider payable, ROVIQ revenue, processing/merchant cost, refunds/adjustments and contribution margin as applicable.
10. Exceptions are visible, owned, recoverable and auditable; tenant boundaries remain intact throughout.
11. Ops can reconstruct the case from canonical records without a manual spreadsheet.
12. Accessibility, privacy, performance, provenance, backup/export and handover evidence is captured for the pilot report.

## Release gate

Before PR #28 or its successor is treated as pilot-ready, all of the following must be true:

- CI and fresh migrations are green on the exact release head.
- The actor acceptance matrix has no unresolved blocker for the supported pilot path.
- One full service-day run passes the scenario above.
- Adversarial tests cover concurrent booking, tenant isolation, connector outage/recovery, duplicate/retried events, provider loss/reassignment, payment failure, notification retry and rollback/recovery.
- Connector and credential health, stale capacity, exception SLA and financial reconciliation are observable in Ops.
- One real founding dealership/shop location completes controlled live cases with automatically captured operational and economic evidence.

Anything not supported by evidence remains **partial** rather than being represented as production-complete.
