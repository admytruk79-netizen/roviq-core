# ROVIQ Maintenance MVP Execution Plan

Status date: 2026-08-23  
Architecture baseline: Master Data Architecture & Technical Specification v2.2  
Business baseline: ROVIQ Business Plan v2.0

## Product contract

ROVIQ coordinates the complete response to a vehicle problem. It does not sell placement, promise a definitive AI diagnosis or behave as a passive lead marketplace. The customer receives one case, one current Service Plan, explicit approvals, coordinated transport/diagnostics/repair/parts/payment, and proactive exception recovery.

The Service Plan is the customer-visible control object. Every material change creates a revision; tasks, commitments, approvals, quotes and events remain traceable to the case and plan.

## Authoritative runtime

| Layer | Responsibility | Must not do |
|---|---|---|
| Customer/partner/admin clients | Role-specific experience and commands | Enforce trust boundaries only in the client |
| Cloudflare Worker | TLS edge, routing, independent edge health, proxy to Core | Persist business commands or duplicate workflow logic |
| Fastify Core | Authentication, authorization, orchestration, AI contract, audit, APIs | Depend on client-supplied ownership decisions |
| Neon Postgres | System of record, constraints, transactions, event/outbox data | Contain secret routing weights in public outputs |

## Revenue order

1. Launch: diagnostic coordination fee, case coordination fee and partner subscription.
2. Once fulfilment is dependable: tow/valet coordination margin and transparently disclosed parts revenue.
3. Once repeat-use evidence exists: optional customer membership.
4. After actuarial validation: prepaid Care plans with explicit entitlement balances and liability controls.
5. After multi-market reliability: fleet and enterprise contracts.

ROVIQ records gross customer payment, partner payable, tax, processor fee, refund, reserve and platform revenue separately. GMV is never reported as revenue. Paid placement must never affect provider ranking.

## Delivery phases and release gates

### Phase 0 — Truthful foundation

Scope: one authoritative Core, complete migration ledger, access matrix, scoped idempotency, Service Plan schema, reproducible build and honest health checks.

Exit gate:

- All migrations apply in filename order and checksums cannot drift silently.
- A principal cannot read or mutate an unrelated case.
- The same actor/key/body returns the stored result; a changed body returns conflict.
- A new service case atomically creates Service Plan revision 1 and immutable events.
- Tests, TypeScript build and Worker dry-run pass.

### Phase 1 — Coordinated pilot loop

Scope: intake, safety-first AI triage, diagnostic handoff, provider selection, quote, customer approval, scheduled commitment, timeline and operations exception queue.

Exit gate: 20 internal end-to-end simulations and 10 supervised Portland pilot cases complete without orphan cases, silent deadline failures or unauthorized reads.

### Phase 2 — Fulfilment and payment

Scope: transport dispatch, mobility, parts lifecycle, payment authorization/capture/refund, settlement allocations, notifications and webhook replay.

Exit gate: each captured dollar reconciles to allocation records; duplicate webhook and command tests are clean; refund and failed-provider recovery drills pass.

### Phase 3 — Partner subscription

Scope: subscription tiers, usage visibility, invoicing, past-due controls, partner onboarding and service-level reporting.

Exit gate: pilot shops renew voluntarily and contribution margin is positive after support and payment costs.

### Phase 4 — Customer membership and prepaid Care

Scope: entitlements, balances, reservations, redemption/reversal, disclosures, cancellation/refund policy and deferred-revenue reporting.

Exit gate: legal/accounting review complete, benefit liability reconciles, and no plan is sold before capacity and unit economics are validated.

### Phase 5 — Multi-market platform

Scope: enterprise/fleet contracts, market configuration, external integrations, reliability objectives and controlled domain expansion.

Exit gate: a second market launches using configuration and adapters rather than a separate backend.

## Phase 0 implementation ledger

| Work item | Status | Evidence |
|---|---|---|
| Ordered migration ledger with checksums and advisory lock | Implemented | `src/db/migrate.ts` |
| Service Plan and commerce data model | Implemented | `migrations/016_service_plan_commerce.sql` |
| Atomic case + initial Service Plan creation | Implemented | `src/services/orchestration.ts` |
| Role/relation-based case access | Implemented | `src/services/case-access.ts` |
| Scoped idempotency and payload-conflict detection | Implemented | `src/services/orchestration.ts` |
| Service Plan read and admin revision APIs | Implemented | `src/http/routes/service-plans.ts` |
| Edge/Core consolidation | Implemented; edge deploy held until Core is live | `cloudflare/worker.js`, `wrangler.jsonc` |
| Reproducible dependency lock/build | Implemented | `package-lock.json`, CI and Dockerfile |
| Production Neon migration | Pending controlled release | Run after backup/branch rehearsal and schema-drift review |
| Live Core deployment | Pending environment configuration | Requires Core host and secrets |

## Immediate backlog

1. Add customer Service Plan approval/rejection with optimistic revision checks.
2. Add case-level quote creation and merchant-of-record allocation rules.
3. Move all transport, mobility, parts and payment case reads through the shared access service.
4. Add Postgres integration tests on an isolated Neon branch.
5. Add outbox worker, retry policy and webhook signature verification.
6. Add customer timeline projection that removes internal/private fields.
7. Connect AI triage to a configured model endpoint in shadow mode; promote only after evaluation thresholds pass.
8. Seed Portland pilot products/price books with finance-approved values outside public source.
9. Provision and verify Core, set Cloudflare's `CORE_API_URL` secret, then manually deploy and verify the edge gateway.
10. Instrument case duration, diagnostic conversion, handoff failure, exception rate, customer response time and contribution margin.

## Change control

- Additive schema change first; application adoption second; destructive cleanup only after all readers migrate.
- Every command that can create money, inventory, entitlement or external side effects requires idempotency.
- AI output is a proposal. Deterministic safety overrides and human review are mandatory for critical or low-confidence cases.
- Routing applies eligibility before ranking; commercial payment cannot bypass eligibility or determine rank.
- Production migration requires an isolated branch rehearsal, backup/recovery confirmation and a recorded rollback decision.
