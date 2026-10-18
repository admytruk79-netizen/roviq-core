# Pilot hardening status — 18 October 2026

Release baseline: upstream main 505f3d7a14343f6735659356b6ba859fbfcb7f7a. All 702 baseline files were recovered through GitHub and checked against their Git blob hashes. Local fixes preserve the upstream technician open-jobs board and customer ratings. OBD jobs use migration 088; upstream migration 087 is unchanged.

Implemented: failed multi-workspace sign-in cleanup; integration-key revocation and active-actor checks; read-only Android OBDLink scanner transport and exact-origin/main-frame WebView bridge; customer enrollment/revocation; case-scoped technician scan ingestion; original speech observations and reviewed draft assistance; event-scoped persisted analysis jobs, fenced worker leases, bounded cloud inference, explicit fallback status and retries; account-scoped IndexedDB upload recovery without stored bearer tokens.

Validation: 70 dependency-free scenarios passed on Node 24. These execute the modified functions with mocked database, transport, authentication and model boundaries. They are regression evidence, not proof of a physical scanner, production isolation or a live model. The PR adds five local-Postgres scenarios for duplicate enqueue, competing claims, retry identity, expired leases, consent revocation and reviewed-assessment protection. Those require migrated PostgreSQL and are wired into CI; they have not run locally. Existing Core, seven portal, shared-shell and Android PR workflows remain the full-build gates. Standalone Node tests are excluded from Vitest discovery and run in a separate CI job.

Historical isolated Neon testing on 12 October executed the queue claim/publication SQL, duplicate insertion, retry scheduling, stale-lease rejection and revoked-consent filtering. Model output was synthetic. That expiring branch is not a release environment.

Local dependency installation is still blocked by the environment proxy; full type checking, Kotlin compilation and deployed browser validation require CI. No production deployment or production migration is represented by these local checks.

Remaining pilot gates: passing full CI; real Android/MX+ capture and disconnect fixtures; independent customer and company accounts completing a service-day journey; settlement and actual notification delivery; mileage history/reminder acceptance; two-app packaging and native access from the Actor app; capacity and completion behavior when no fulfillment plan exists. This is a proposed hardening release, not an assertion of operational readiness.
