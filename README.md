# ROVIQ Core

ROVIQ Core is the authoritative backend orchestration layer described in **ROVIQ Master Data Architecture & Technical Specification v2.2**.

This repository starts with the Maintenance MVP while preserving the reusable primitives required for later domains such as ROVIQ Station.

## Current foundation

- Fastify + TypeScript backend
- PostgreSQL schema for domains, actors, capabilities, capacity, demand, offers, transactions, events, policies and audit records
- Server-side principal/actor scoping
- Customer demand intake
- Service-case orchestration and guarded state transitions
- Immutable case events and customer-facing snapshots
- Workflow deadlines, fallback processing and exception queue
- Admin actor/capability management
- Partner-owned capacity management
- Maintenance eligibility and runtime-policy routing
- Versioned routing decisions with policy traceability
- Manual dispatch/offer creation
- Partner accept/decline flow
- Diagnostic findings workflow
- Transaction state changes and immutable events
- Operational ledger primitives
- Audit trail
- Maintenance-domain seed migrations
- Isolation-focused tests
- Service Plan aggregate with immutable revisions, tasks, commitments and approvals
- Product catalog, price books, quotes, subscriptions, entitlements, refunds, disputes and revenue allocation primitives
- Checksum-verified, concurrency-safe migration ledger
- Fail-closed case access across customer, shop, diagnostic, transport, parts and fleet roles
- Tow/valet transport dispatch, assignment and status tracking
- Loaner/fleet mobility resource allocation and state management
- Parts ordering, supplier assignment, reservation and fulfilment lifecycle
- Payments, refunds, partner payouts and per-case financial rollups
- Notification outbox with templates, per-channel delivery and retry attempts
- AI triage engine with human review, ground-truth capture and shadow/auto promotion evaluation
- External integration gateway: registered clients, webhook subscriptions and delivery tracking

## Routing policy boundary

ROVIQ Core no longer hard-codes proprietary ranking weights in source. Eligibility produces routing signals, while ranking behavior is loaded from an active, versioned runtime policy stored in PostgreSQL. If no policy is active, the engine fails closed: eligible providers may be returned, but Core does not automatically select a provider.

Routing policy configuration is admin-only and is intentionally not returned by the policy-list endpoint. This keeps deployable source separate from private operating policy.

## Run locally

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:8080` by default.

## End-to-end tests

`npm test` (used by CI) only runs fast unit tests with no external dependencies — `tests/isolation.test.ts` and `tests/case-access.test.ts`. Four suites drive a real Fastify app instance end-to-end:

- `tests/e2e-maintenance-case.e2e.test.ts`: intake, automated routing, provider offer/acceptance, a Service Plan quote revision, payment capture, auto-completion, and a fail-closed isolation check for an unrelated customer, then asserts the full event timeline is auditable.
- `tests/e2e-transport-dispatch.e2e.test.ts`: tow dispatch from creation through admin assignment, provider capability enforcement (`409 provider_not_transport_capable`), an invalid status-skip rejection (`409 invalid_dispatch_transition`), dispatch-level access control for an unassigned provider (`403 dispatch_forbidden`), the full `accepted → en_route → arrived → vehicle_loaded → in_transit → delivered` lifecycle (which auto-transitions the case `tow_pending → tow_in_progress` and resolves the transport-assignment deadline), and the tow-to-repair case handoff.
- `tests/e2e-mobility-allocation.e2e.test.ts`: loaner allocation request, request-side isolation for an unrelated customer, resource assignment with conflict enforcement (`409 resource_provider_mismatch`, `409 resource_unavailable` once a resource is taken), allocation-level access control for an unrelated provider (`403`), an invalid state-skip rejection (`409 invalid_allocation_transition`), the full `assigned → active → return_pending → completed` lifecycle, and that completion frees the resource back up for the next allocation.
- `tests/e2e-parts-order.e2e.test.ts`: parts order creation (auto-transitioning the case `repair_in_progress → parts_pending`), reservation against real inventory (rejecting a reserve with no stock as `409 inventory_unavailable:<sku>`), supplier-type enforcement (`400 invalid_supplier_type`), order-level access control for a supplier not assigned to the order (`403`), an invalid status-skip rejection (`409 invalid_parts_transition`), the full `reserved → ordered → shipped → delivered` lifecycle (which decrements on-hand stock, releases the reservation, and resumes the case `parts_pending → repair_in_progress`), and that cancelling a separate reserved order releases its reservation back to inventory.

It needs a real Postgres database (Neon's connection semantics differ enough from a plain `pg.Pool` that a real Postgres, not a mock, is required) and is excluded from `npm test` — CI has no database available. Run it locally against a **fresh** database (leftover actors from a previous run change automated-routing rankings and make the test flaky):

```bash
createdb roviq_test
DATABASE_URL=postgresql://localhost/roviq_test ADMIN_API_KEY=test-key JWT_SECRET=$(openssl rand -hex 32) ALLOW_DEV_HEADERS=true npm run db:migrate
DATABASE_URL=postgresql://localhost/roviq_test ADMIN_API_KEY=test-key JWT_SECRET=<same-secret-as-above> ALLOW_DEV_HEADERS=true npm run test:e2e
```

Every quote revision (`POST /api/admin/maintenance/cases/:id/service-plan/revisions` with an `estimatedTotalMinor`) creates a pending `case_approvals` row for the customer. The customer (or admin) decides it via `POST /api/maintenance/cases/:id/approvals/:approvalId/decision`, and `POST /api/admin/payments` refuses to create a payment intent until the current revision's quote is approved (`409 quote_not_approved`) — the e2e test asserts both the block and the unblock.

## Authentication

Production requests use signed JWT identity. Development/bootstrap headers can be enabled explicitly with `ALLOW_DEV_HEADERS=true`.

- `x-roviq-role`: `admin`, `customer`, `partner`, `diagnostic`, `tow`, `parts`, `fleet`
- `x-roviq-actor-id`: required for actor-scoped development roles
- `x-admin-api-key`: bootstrap/admin access where configured

Authorization middleware enforces actor ownership server-side; clients cannot gain access by supplying another actor ID.

## Core route groups

- `GET /health`
- `POST /api/auth/login`
- `POST /api/demands`
- `GET /api/demands/:id`
- `POST /api/maintenance/cases`
- `GET /api/maintenance/cases/:id`
- `GET /api/maintenance/cases/:id/timeline`
- `POST /api/maintenance/cases/:id/transition`
- `GET /api/maintenance/cases/:id/service-plan`
- `POST /api/admin/maintenance/cases/:id/service-plan/revisions`
- `POST /api/maintenance/cases/:id/approvals/:approvalId/decision`
- `GET /api/partners/me/offers`
- `POST /api/offers/:id/respond`
- `PATCH /api/partners/me/capacity`
- `GET /api/partners/me/capacity`
- `POST /api/admin/actors`
- `POST /api/admin/offers`
- `POST /api/admin/routing-policies`
- `GET /api/admin/routing-policies`
- `GET /api/admin/audit`
- `POST /api/admin/transport`, `POST /api/admin/transport/:id/assign`, `GET /api/transport/:id`, `POST /api/transport/:id/status`
- `POST /api/admin/mobility/resources`, `GET /api/mobility/resources/available`, `POST /api/maintenance/cases/:id/mobility`, `POST /api/mobility/:id/state`
- `POST /api/maintenance/cases/:caseId/parts-orders`, `POST /api/parts/orders/:id/reserve`, `POST /api/parts/orders/:id/status`, `PUT /api/parts/inventory`
- `POST /api/admin/payments`, `POST /api/admin/payments/:id/state`, `POST /api/admin/payments/:id/refunds`, `POST /api/admin/payouts`, `GET /api/admin/cases/:id/financials`
- `POST /api/admin/notifications/process`, `GET /api/admin/notifications/outbox`, `POST /api/admin/notifications/templates`
- `POST /api/maintenance/cases/:id/triage/run`, `POST /api/triage/:id/review`, `POST /api/admin/triage/evaluate`, `PUT /api/admin/triage/promotion-policy`
- `POST /api/admin/integrations/clients`, `POST /api/admin/integrations/webhooks`, `POST /api/admin/integrations/deliver`

## Runtime boundary

Fastify Core (`src/`) is the only authoritative application backend and the only component that persists business commands to Neon Postgres. It deploys to Render. The Cloudflare Worker (`cloudflare/worker.js`) is an edge gateway: it answers its own health checks (`/health`, `/edge-health`, `/ready`) and runs AI-assisted triage directly against Workers AI (writing results straight to Neon, since triage is edge model-execution per the business plan), and forwards every other `/api/*` request to Core via the `CORE_API_URL` var in `wrangler.jsonc`. Core remains the only place authorization, workflow and audit behavior is decided; the edge does not duplicate business rules.

## Deployment

Two components, one system of record (Neon Postgres):

- **Core** (`src/`, Fastify): deploys to Render (`render.yaml`) at `https://roviq-core.onrender.com`. Migrations run automatically on boot via `npm run db:migrate:prod`.
- **Edge** (`cloudflare/worker.js`): deploys via `.github/workflows/deploy-cloudflare.yml` on every push to `main`. Its `DATABASE_URL` secret is used for AI triage writes.

### Rotating the Neon password

Both components read the same Neon connection string, but each holds its own copy (Cloudflare Worker secret, Render service env var). Run the **Rotate ROVIQ Core Database Secret** workflow (`.github/workflows/rotate-database-secret.yml`, `workflow_dispatch`) to push a new password to both from a single source: it reads the `NEON_DATABASE_URL` repository secret and writes it to the Cloudflare Worker secret (`wrangler secret put`) and to the Render service's env vars (via the Render API), which also triggers a Render redeploy. Update `NEON_DATABASE_URL`, then run this one workflow — no manual dashboard edits.

Required repository secrets for this workflow: `NEON_DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RENDER_API_KEY` (Render dashboard → Account Settings → API Keys), `RENDER_SERVICE_ID` (the `srv-...` id in the Render service's dashboard URL).

## Remaining work

Tow/valet dispatch, loaner/fleet allocation, parts fulfilment, payments, notifications, AI triage and the integration gateway are all implemented (see routes above). What's left:

1. Domain adapters that reuse Core for ROVIQ Station and later operating domains
2. Functional test coverage for the remaining domains (payments, notifications, triage, integrations currently have no dedicated tests — maintenance, transport, mobility and parts are covered end-to-end, case-access/isolation are covered by unit tests)
