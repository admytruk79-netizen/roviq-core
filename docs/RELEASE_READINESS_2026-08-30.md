# ROVIQ Release Readiness Matrix — 2026-08-30

Status key: GREEN = implementation and automated verification present. PARTIAL = implemented but browser/role-flow verification remains. BLOCKED = known release blocker.

| Area | Status | Evidence / remaining work |
|---|---|---|
| Core API build | GREEN | TypeScript build and Worker bundle validation are part of CI. |
| Core Worker deployment | GREEN | Deploy workflow validates Worker, Core/Neon connectivity, and edge proxy. |
| Customer → outcome lifecycle | GREEN | Maintenance E2E covers provider selection, approval, payment, completion and isolation. |
| Cross-role lifecycle | GREEN | Cross-role E2E covers Customer → Diagnostic → Tow → Partner → Parts → approval/payment → completed. |
| Tow dispatch authorization | GREEN | Assignment-scoped dispatch read/status/location checks and spatial authorization regression coverage. |
| Spatial role projection | GREEN | Core projects case spatial context by role and tests prevent Tow leakage of diagnostic/parts-only fields. |
| Tow decline / reassignment | GREEN | Degraded-path regression verifies ownership clearing, stale-provider GPS denial, reassignment and recovery. |
| Parts shortage recovery | GREEN | Regression verifies unavailable inventory does not corrupt case state and fulfilment can resume. |
| Diagnostic assignment isolation | GREEN | Unassigned diagnostic finding attempts are rejected without state mutation. |
| Local dependency isolation | GREEN | Adapter is whitelisted, does not forward caller authorization, and returns bounded upstream failure. |
| Workers AI authority | GREEN | Shadow/advisory cannot automate; assisted remains blocked by safety override or human-review requirements. |
| Workers AI outage behavior | GREEN | Missing AI binding is isolated from authoritative Core mutation paths. |
| Integration/webhook retry | GREEN | Existing E2E covers signed delivery, retry and dead-letter behavior. |
| Customer frontend | PARTIAL | Mobile hierarchy simplified and case-first. Production HTTP smoke now automated; authenticated browser workflow still needs release-browser pass. |
| Diagnostic frontend | PARTIAL | Mobile workflow fixes present. Production HTTP smoke now automated; authenticated browser workflow still needs release-browser pass. |
| Partner frontend | PARTIAL | Mobile layout and offer workflow improved. Production HTTP smoke now automated; subtype/onboarding browser pass remains. |
| Parts frontend | PARTIAL | Mobile fulfilment workflow improved. Production HTTP smoke now automated; authenticated end-to-end browser pass remains. |
| Tow frontend | PARTIAL | Operational controls and Local map integration restored. Production shell smoke now automated; actual roads/map rendering and GPS behavior still require browser/device verification. |
| Ops frontend | PARTIAL | Control-plane dashboard and spatial network surface present. Production HTTP smoke now automated; exception/map interaction browser pass remains. |
| Session expiry handling | PARTIAL | Role auth exists; consistent expired-session redirect/recovery should be verified across all six surfaces. |
| Browser Back behavior | PARTIAL | Requires role-by-role browser verification, especially wrapped/mobile flows. |
| Error recovery / stale state | PARTIAL | Backend failures are bounded; every frontend still needs explicit retry/stale-state UX verification. |
| Accessibility / keyboard | PARTIAL | Touch-target and mobile improvements exist; full keyboard/focus/contrast audit remains. |
| Tablet / narrow mobile QA | PARTIAL | Mobile CSS passes have been made; systematic viewport matrix remains. |
| Visual regression protection | PARTIAL | Production shell smoke catches HTTP failures and known failure markers; screenshot-based regression testing is not yet implemented. |
| Unified launcher | PARTIAL | Launcher source/workflow exists; production verification remains separate from the six role surfaces. |

## Release gate

ROVIQ should not be declared fully production-ready until all six role surfaces pass the production smoke workflow and the following manual browser/device gate is completed for each role: login, landing render, primary case/queue load, one primary action, map render where applicable, browser Back, sign-out, expired-session recovery, API failure recovery, and mobile viewport inspection.

## Automated production smoke

Workflow: `.github/workflows/smoke-production-surfaces.yml`

It checks the Customer, Diagnostic, Partner, Parts, Tow and Ops production aliases for successful HTML delivery, rejects known failure markers, and verifies both `/health` and `/ready` on the Core Worker.

This smoke is intentionally a release shell gate, not a substitute for authenticated browser/device testing. A successful deployment or HTTP response must never be treated as proof that a map, workflow, or responsive layout is visually correct.
