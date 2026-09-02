# ROVIQ Release Readiness Matrix — 2026-09-01

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
| Transport pickup inheritance | PARTIAL | New transport dispatches inherit canonical case GPS when pickup is omitted. Requires migration/deployment and live regression verification. |
| Tow decline / reassignment | PARTIAL | Core now releases a declined dispatch back to `requested`, clears provider ownership and case transport ownership, and preserves decline audit metadata. Reassignment automation/browser verification remains. |
| Field-service data model | PARTIAL | `field_service_decisions` migration and API are implemented. Production migration and integration tests remain. |
| Diagnostic → field-service handoff | PARTIAL | Diagnostics supports `field_service_assessment` without bypassing the case state machine. Diagnostic UI and end-to-end verification remain. |
| Field-service safety policy | PARTIAL | Core enforces deterministic baseline gates for unsafe conditions, non-drivable vehicles, low confidence and missing operator/tool/part capability. Policy test matrix remains. |
| Field-service customer authorization | PARTIAL | Core blocks start when customer authorization is required and absent. Customer UI/quote/payment coupling and browser verification remain. |
| Field-service execution | PARTIAL | Authorized field repair can start and record fixed/stabilized/failed/escalated outcome. Parts reservation, settlement and full workflow recovery remain. |
| Parts shortage recovery | GREEN | Regression verifies unavailable inventory does not corrupt case state and fulfilment can resume. |
| Diagnostic assignment isolation | GREEN | Unassigned diagnostic finding attempts are rejected without state mutation. |
| Local dependency isolation | GREEN | Adapter is whitelisted, does not forward caller authorization, and returns bounded upstream failure. |
| Workers AI authority | GREEN | Shadow/advisory cannot automate; assisted remains blocked by safety override or human-review requirements. |
| Workers AI outage behavior | GREEN | Missing AI binding is isolated from authoritative Core mutation paths. |
| Integration/webhook retry | GREEN | Existing E2E covers signed delivery, retry and dead-letter behavior. |
| Scheduled operations sweep | BLOCKED | The scheduled workflow is still pointed at the legacy Render Core URL and requires missing `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` repository secrets. The latest scheduled run fails before any deadline or notification processing occurs. |
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

Field repair must remain pilot/controlled until all of the following pass:

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

ROVIQ should not be declared fully production-ready until the scheduled operations sweep is repaired and the following manual browser/device gate is completed for each role: login, landing render, primary case/queue load, one primary action, map render where applicable, browser Back, sign-out, expired-session recovery, API failure recovery, mobile viewport inspection, and the new diagnostic/field-service/transport branch where applicable.

## Automated production smoke

Workflow: `.github/workflows/smoke-production-surfaces.yml`

It checks the Customer, Diagnostic, Partner, Parts, Tow and Ops production aliases for successful HTML delivery, rejects known failure markers, and verifies both `/health` and `/ready` on the Core Worker. The first production smoke run completed successfully across the entire matrix.

This smoke is intentionally a release shell gate, not a substitute for authenticated browser/device testing. A successful deployment or HTTP response must never be treated as proof that a map, workflow, field-service authorization or responsive layout is visually correct.

## Current operational blocker

`.github/workflows/scheduled-operations-sweep.yml` is stale. It targets `https://roviq-core.onrender.com` and attempts to log in with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`; those secrets are absent, so the job stops at login and never runs deadline or notification processing. Repairing this workflow is a production-readiness requirement, not an optional cleanup.
