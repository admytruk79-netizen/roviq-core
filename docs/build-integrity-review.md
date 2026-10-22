# Build integrity review — credential handshake

Scope: Customer and Actor products, Core/Worker builds, all automotive assignment writes (offers/open jobs, selection, transport, parts, mobility and network handoffs), identity/tenant checks, existing scanner/analysis recovery tests, PostgreSQL migrations and backup/restore/restart acceptance.

## Closed in this change

Service qualification previously had no central, expiring business credential record. Actor type and capability flags could remain active after a license expired, and checking only the UI would miss alternate API/claim paths. Migration 090 adds authoritative credential checks at database assignment boundaries and locks them against credential changes. Ops can attest, suspend, renew and audit authorizations; expired/missing credentials appear on existing-work review. New onboarding enrolls automatically. Follow-up migration 091 covers roadside repair authorization/start after diagnosis and standalone Shop OS repair approval/first start; an existing accepted diagnostic job is not sufficient authorization for physical repair. The production browser also exposed duplicate Ops transition controls in the overview and detail panels. The overview is now read-only in the combined case screen and refreshes when authoritative case details reload. Whole-build CI must pass before rollout.

## Material limits and findings still open

- Legacy organizations require explicit enrollment and credential review. Their existing flags are not evidence of a valid license. The Ops UI labels this state; no legacy authorizations are silently manufactured.
- `src/services/network-execution.ts:evaluateFulfillmentCompletion` treats a missing fulfillment plan as ready, and `recordCompletionOutcome` only checks blockers when a plan exists. This legacy completion behavior is not a proof that all service dependencies were fulfilled. It needs a migration/contract decision and dedicated acceptance coverage before removing the fallback; this change does not silently redefine historical workflows.
- Existing assignment paths differ in how geography, capacity, tools and certifications are assessed. The credential gate is an additional common requirement, not proof that all paths use an identical readiness policy. Explicit administrative/manual dispatch still needs operational review.
- The generic Core engine supports domains beyond automotive service; those task/participant flows need their own capability mappings before adopting this registry.
- Latest scheduled inventory sync (2026-10-22 10:18 UTC) refreshed four sources but Buick/GMC Beaverton returned HTTP 403 after retries. Its prior snapshot was retained. This source-access issue needs an approved, stable feed or restored access; it is not a database-emptying failure.
- Physical Bluetooth scanner testing, independent business onboarding/pilot evidence, payment settlement/refunds/payouts, external notification delivery and load/failure testing remain outstanding. Existing production lifecycle evidence uses scoped test accounts and reaches payment pending, not commercial settlement.
- Identity roles are intentionally separate from service authorizations. Expiry does not delete an account or remove historical access. Person-specific credentials and jurisdiction-specific credential bundles still require human verification.

## Verification

Run all existing dependency-free simulations, unit/Worker checks, builds for both products and all role modules, full real-Postgres acceptance, OBD queue concurrency/recovery, migration application, backup/restore and restart persistence in CI. Added credential acceptance covers three services becoming two on expiry, renewal, assignment-to-acceptance expiry, write-path bypass attempts, unauthorized review, ongoing-work visibility, future validity, wall-clock expiry and credential-update/assignment serialization. Production browser acceptance checks the Ops eligibility screen/registry and reruns the multi-actor lifecycle without enrolling any real legacy business or inventing credentials.
