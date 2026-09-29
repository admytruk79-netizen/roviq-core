# ROVIQ Release Readiness Matrix — 2026-09-26

Status key: GREEN = implementation and automated verification present. PARTIAL = implemented but browser/role-flow verification remains. BLOCKED = known release blocker.

| Area | Status | Evidence / remaining work |
|---|---|---|
| Core API build | GREEN | TypeScript build and Worker bundle validation are part of CI. |
| Core Worker deployment | GREEN | Deploy workflow validates Worker, Core/Neon connectivity, and edge proxy. |
| Production shell smoke | GREEN | Automated smoke passed for Customer, Diagnostic, Partner, Parts, Tow, Ops, Core `/health`, and Core `/ready`. |
| Customer → outcome lifecycle | GREEN | Maintenance E2E covers provider selection, approval, payment, completion and isolation. |
| Cross-role lifecycle | GREEN | Cross-role E2E covers Customer → Diagnostic → Tow → Partner → Parts → approval/payment → completed. |
| Customer intake GPS | PARTIAL | New maintenance intake requires precise device GPS and stores it in case attributes plus canonical spatial context. Existing pre-GPS cases require recapture/recovery UX and device verification. |
| Tow dispatch authorization | GREEN | Assignment-scoped dispatch read/status/location checks and spatial authorization regression coverage. |
| Spatial role projection | GREEN | Core projects case spatial context by role and tests prevent Tow leakage of diagnostic/parts-only fields. |
| Transport pickup inheritance | GREEN | Dispatches inherit canonical case GPS when pickup is omitted and keep an explicit pickup when given, with provenance in `metadata.pickupSource`. Field-service gate item 9 verifies both. Live device verification remains part of the browser gate. |
| Tow decline / reassignment | GREEN | A declined dispatch returns to `requested`, drops the declining provider's ownership and case access, keeps decline audit metadata, and can be assigned to another provider; handoff state follows reassignment (#53). Field-service gate item 10 and `e2e-transport-dispatch` verify this. Browser verification remains. |
| Field-service data model | GREEN | `field_service_decisions` and capability profiles apply on a fresh database in CI and are covered by Postgres end-to-end tests. |
| Diagnostic → field-service handoff | PARTIAL | Diagnostics supports `field_service_assessment` without bypassing the case state machine, and the Diagnostic portal submits on-site assessments. Authenticated browser verification remains. |
| Field-service safety policy | GREEN | Core enforces deterministic gates for every safety flag, non-drivable vehicles, low confidence, unknown repair class and missing repair class/capability/tool/part/time/cost limits. `/start` re-checks the operator's current profile under the same transaction. The policy matrix is `tests/e2e-field-service-production-gate.e2e.test.ts`. |
| Field-service customer authorization | PARTIAL | Core requires customer authorization by default and blocks start without it; operators cannot waive it or authorize their own decisions (only admin can issue a no-authorization decision). The Customer portal can approve/decline. Quote/payment coupling and browser verification remain. |
| Field-service execution | PARTIAL | Authorized field repair starts, reserves required parts under contention, and records fixed/stabilized/failed/escalated outcomes with evidence; failed work releases reserved parts and leaves the case open for another path. Settlement remains. |
| Parts shortage recovery | GREEN | Regression verifies unavailable inventory does not corrupt case state and fulfilment can resume. |
| Diagnostic assignment isolation | GREEN | Unassigned diagnostic finding attempts are rejected without state mutation. |
| Local dependency isolation | GREEN | Adapter is whitelisted, does not forward caller authorization, and returns bounded upstream failure. |
| Workers AI authority | GREEN | Shadow/advisory cannot automate; assisted remains blocked by safety override or human-review requirements. |
| Workers AI outage behavior | GREEN | Missing AI binding is isolated from authoritative Core mutation paths. |
| Integration/webhook retry | GREEN | Existing E2E covers signed delivery, retry and dead-letter behavior. |
| Scheduled operations sweep | GREEN | Runs natively as a Cloudflare cron in the Core Worker every 10 minutes (`wrangler.jsonc`). `scheduled-operations-sweep.yml` is now a manual check that production `/health` advertises `scheduledOperations: cloudflare-cron`. |
| Customer frontend | PARTIAL | Mobile hierarchy simplified and case-first. Production HTTP smoke is green; authenticated browser workflow still needs release-browser pass. Field-service authorization UI remains. |
| Diagnostic frontend | PARTIAL | Mobile workflow fixes present. Production HTTP smoke is green; authenticated browser workflow and field-service assessment controls remain. |
| Partner frontend | PARTIAL | Mobile layout and offer workflow improved. Production HTTP smoke is green; subtype/onboarding browser pass and field-service capability declaration remain. |
| Parts frontend | PARTIAL | Mobile fulfilment workflow improved. Production HTTP smoke is green; field-service reservation/dispatch integration remains. |
| Tow / Field Operations frontend | PARTIAL | Operational controls and Local map integration restored. Needs canonical spatial read, field-service decision card, authorization state, approved start/complete controls and device verification. |
| Ops frontend | PARTIAL | Control-plane dashboard and spatial network surface present. Field-service exception/review controls and map interaction browser pass remain. |
| Session expiry handling | PARTIAL | Role auth exists; consistent expired-session redirect/recovery should be verified across all six surfaces. |
| Browser Back behavior | PARTIAL | Requires role-by-role browser verification, especially wrapped/mobile flows. |
| Error recovery / stale state | PARTIAL | Backend failures are bounded; every frontend still needs explicit retry/stale-state UX verification. |
| Accessibility / keyboard | PARTIAL | Touch-target and mobile improvements exist; full keyboard/focus/contrast audit remains. |
| Tablet / narrow mobile QA | PARTIAL | Mobile CSS passes have been made; systematic viewport matrix remains. |
| Visual regression protection | PARTIAL | Production shell smoke catches HTTP failures and known failure markers; screenshot-based regression testing is not yet implemented. |
| Unified launcher | PARTIAL | Launcher source/workflow exists; production verification remains separate from the six role surfaces. |

## Field-service production gate

Field repair must remain pilot/controlled until all of the following pass. Each item is a `describe` block in `tests/e2e-field-service-production-gate.e2e.test.ts`, run by CI's system-acceptance job; all ten pass as of 2026-09-26. The browser/device gate below still applies before field repair leaves controlled pilot.

1. unsafe safety flags always produce `tow_required`;
2. `non_drivable` always produces `tow_required`;
3. confidence below the policy threshold cannot start repair;
4. missing operator capability/tool/part cannot start repair;
5. customer authorization is enforced when required;
6. unrelated actors cannot read or mutate a field-service decision;
7. an authorized field repair can start and complete with evidence;
8. failed/escalated work returns to an actionable service path without orphaning the case;
9. transport dispatch inherits the case GPS;
10. declined transport is removed from the declining provider and becomes assignable to another eligible provider.

Architecture reference: `docs/FIELD_SERVICE_ONSITE_REPAIR_ARCHITECTURE.md`.

## Release gate

ROVIQ should not be declared fully production-ready until the following manual browser/device gate is completed for each role: login, landing render, primary case/queue load, one primary action, map render where applicable, browser Back, sign-out, expired-session recovery, API failure recovery, mobile viewport inspection, and the new diagnostic/field-service/transport branch where applicable.

## Automated production smoke

Workflow: `.github/workflows/smoke-production-surfaces.yml`

It checks the Customer, Diagnostic, Partner, Parts, Tow and Ops production aliases for successful HTML delivery, rejects known failure markers, and verifies both `/health` and `/ready` on the Core Worker. The first production smoke run completed successfully across the entire matrix.

This smoke is intentionally a release shell gate, not a substitute for authenticated browser/device testing. A successful deployment or HTTP response must never be treated as proof that a map, workflow, field-service authorization or responsive layout is visually correct.

## Current operational blocker

None in code. The earlier blocker (the scheduled sweep pointing at the legacy Render Core) was resolved by moving scheduled operations into the Core Worker's native Cloudflare cron. What remains before production is the manual browser/device release gate above and a controlled pilot with a real partner location.
