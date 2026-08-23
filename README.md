# ROVIQ Core

ROVIQ Core is the backend orchestration layer described in **ROVIQ Master Data Architecture & Technical Specification v2.1**.

This repository starts with the Maintenance MVP while preserving the reusable primitives required for later domains such as ROVIQ Station.

## Current foundation

- Fastify + TypeScript backend
- PostgreSQL schema for domains, actors, capabilities, capacity, demand, offers, transactions, events, policies and audit records
- Server-side principal/actor scoping
- Customer demand intake
- Admin actor/capability management
- Partner-owned capacity management
- Manual dispatch/offer creation
- Partner accept/decline flow
- Transaction state changes and immutable events
- Audit trail
- Maintenance-domain seed migration
- Isolation-focused tests

## Run locally

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:8080` by default.

## Authentication in this first build

Production identity integration is intentionally separated from authorization. During the foundation stage, requests identify a principal with headers:

- `x-roviq-role`: `admin`, `customer`, `partner`, `diagnostic`, `tow`, `parts`, `fleet`
- `x-roviq-actor-id`: required for actor-scoped roles
- `x-admin-api-key`: required for admin requests

The authorization middleware enforces actor ownership server-side; clients cannot gain access by supplying another actor ID.

## MVP route groups

- `GET /health`
- `POST /api/demands`
- `GET /api/demands/:id`
- `GET /api/partners/me/offers`
- `POST /api/offers/:id/respond`
- `PATCH /api/partners/me/capacity`
- `GET /api/partners/me/capacity`
- `POST /api/admin/actors`
- `POST /api/admin/offers`
- `GET /api/admin/audit`

## Next build

1. Real identity provider + sessions/JWT
2. Automated Maintenance eligibility/ranking engine
3. Diagnostic workflow
4. Tow/valet dispatch
5. Stripe/payment ledger
6. Partner controls + OEM/warranty rules
7. Loaner/fleet resource flow
8. Parts ordering
9. AI triage contract
