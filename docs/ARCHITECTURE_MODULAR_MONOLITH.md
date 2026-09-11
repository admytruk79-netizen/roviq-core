# ROVIQ Core architecture: lean modular monolith

Status: adopted for incremental hardening on `productionize-shop-os-operations`.

## Decision

ROVIQ Core stays a modular monolith. We will not rewrite it into microservices and we will not move domain authority into the portals. The current system already has a useful canonical center: PostgreSQL for business state, Fastify for authoritative workflow/policy, and thin role-specific clients.

The refactor model is **functional core / imperative shell + vertical domain modules**:

- **Domain**: pure rules, state transitions, ranking math, invariants, policy evaluation. No SQL, HTTP, timers, or external SDKs.
- **Application**: use-case orchestration and transaction boundaries. It coordinates domain rules and ports, but does not own transport/framework details.
- **Infrastructure**: PostgreSQL repositories, Stripe/connectors, Cloudflare integrations, notification transports, external systems.
- **HTTP**: Fastify route parsing, authorization entry points, validation, status/error mapping. Routes call application use cases and do not duplicate business rules.

The Coordination Engine remains a pure domain component. Routing, provider selection, Shop OS, transport, mobility, payments, and integrations become bounded modules around it.

## Architectural invariants

1. PostgreSQL remains the canonical business-state source of truth.
2. Fastify Core remains authoritative for authorization, workflow, routing, orchestration, audit, and policy.
3. Role frontends remain thin projections and never become alternate workflow engines.
4. One business invariant has one authoritative implementation. Entry points may differ; mutation pipelines should not.
5. Production-critical writes use explicit transaction boundaries and a documented global lock order.
6. Operational projections are mutation-driven and source-specific; unrelated mutations must not refresh or overwrite another domain's projection.
7. External side effects occur through explicit ports/outbox patterns after authoritative state is committed unless atomicity requires otherwise.
8. Pure domain logic is deterministic and easy to unit test. Infrastructure behavior is covered by integration/E2E tests.
9. No speculative abstraction. A shared primitive is extracted when two or more production paths express the same invariant or transaction sequence.
10. Refactors are behavior-preserving first. Public HTTP contracts and persisted semantics change only with explicit migration/tests.

## Target module shape

```text
src/
  domain/
    coordination/
    serviceability/
    cases/
    scheduling/
  application/
    cases/
    routing/
    selection/
    shop-os/
    transport/
    mobility/
    payments/
    integrations/
  infrastructure/
    db/
    payments/
    integrations/
    notifications/
  http/
    routes/
    middleware/
```

This is a direction, not a big-bang folder move. Existing files migrate only when touched for correctness or meaningful duplication reduction.

## Refactor sequence

### 1. Provider selection pipeline

Unify the repeated critical path currently present in customer/dealer selection, existing-offer selection, and auto-dispatch:

`lock case -> authorize mode -> resolve capability -> revalidate serviceability -> reserve capacity -> persist selection -> close competing offers -> append events`

Entry points keep their distinct authority rules while sharing the invariant-bearing execution primitives.

### 2. Operational projection ownership

Each source domain owns its projection refresh:

- parts -> parts readiness
- mobility -> mobility readiness
- appointments -> customer time
- approvals -> approval readiness
- transport -> destination/provider readiness

Broad projection refresh remains only for explicit rebuild/reconciliation tooling, not normal unrelated mutations.

### 3. Case lifecycle split

Separate case lifecycle state mutation from generic event, deadline/exception, idempotency, and integration publication helpers. Keep one transaction owner for a use case.

### 4. Routing shell

Keep ranking mathematics in the Coordination Engine. Split routing into candidate discovery, eligibility/serviceability, engine invocation, and decision persistence.

### 5. Shop OS boundaries

Extract scheduling/capacity, repair-order, floor/WIP, parts/deferred-service, and board/read-model responsibilities behind narrow application interfaces. Preserve the global scheduling lock order.

### 6. Shared frontend platform

Consolidate API client, auth/session, error mapping, generated/shared types, design tokens, and accessible primitives. Portals remain separately deployable role surfaces.

### 7. Toolchain and CI

Standardize Node/TypeScript/Vite/Wrangler/lint versions and replace repeated deployment workflows with reusable parameterized workflows where doing so reduces configuration drift.

## Explicit non-goals

- No microservice split for its own sake.
- No event-sourcing rewrite.
- No generic repository framework over every SQL statement.
- No dependency-injection container merely for style.
- No frontend monolith that mixes role authorization boundaries.
- No change to proprietary coordination/routing behavior solely to make code look symmetrical.

## Quality gate for every extraction

An extraction is accepted only if it improves at least one of: invariant centralization, concurrency safety, testability, dependency direction, or duplicated production logic, while keeping behavior and operational observability intact.
