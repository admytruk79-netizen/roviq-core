# ROVIQ Core

ROVIQ Core is the backend orchestration layer described in **ROVIQ Master Data Architecture & Technical Specification v2.1**.

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
- `GET /api/partners/me/offers`
- `POST /api/offers/:id/respond`
- `PATCH /api/partners/me/capacity`
- `GET /api/partners/me/capacity`
- `POST /api/admin/actors`
- `POST /api/admin/offers`
- `POST /api/admin/routing-policies`
- `GET /api/admin/routing-policies`
- `GET /api/admin/audit`

## Next operational layers

1. Tow/valet dispatch execution
2. Loaner/fleet resource allocation
3. Parts ordering and fulfilment lifecycle
4. Payment provider integration against the ledger boundary
5. Notification adapters for actor-specific front ends
6. AI triage contract with human/diagnostic escalation controls
7. Domain adapters that reuse Core for ROVIQ Station and later operating domains
