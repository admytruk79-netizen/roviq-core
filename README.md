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

Fastify Core is the only authoritative application backend and the only component that persists business commands to Neon Postgres. The Cloudflare Worker is an edge gateway: it exposes an independent edge health check and forwards `/api/*` and `/ready` to Core. Set its `CORE_API_URL` secret and verify Core before manually dispatching the edge deployment workflow. This avoids separate authorization, workflow and audit behavior at the edge.

## Deployment

Live on Render (free tier): `https://roviq-core.onrender.com`. Backed by Neon Postgres; migrations run automatically on boot via `npm run db:migrate:prod`. A Cloudflare Worker + Containers path also exists (`wrangler.jsonc`, `Dockerfile`) but requires a paid Workers plan for the Containers image registry — Render is the currently verified free deploy path.

## Remaining work

Tow/valet dispatch, loaner/fleet allocation, parts fulfilment, payments, notifications, AI triage and the integration gateway are all implemented (see routes above). What's left:

1. Domain adapters that reuse Core for ROVIQ Station and later operating domains
2. Functional test coverage for the newer domains (transport, mobility, parts, payments, notifications, triage, integrations currently have no dedicated tests — only case-access/isolation are covered)
3. Upgrading the Cloudflare Containers deploy path once the account is on a paid Workers plan, so edge deployment stops depending on Render
