# ROVIQ Partner Demo Runbook

Purpose: run a real production-backed demonstration without developer-only shortcuts or hidden database setup.

## Primary entry point

Use the unified launcher:

- https://roviq-portals.pages.dev

It exposes Customer first, then Diagnostic, Partner, Parts, Tow / Valet, and Ops workspaces. Each workspace also has an **Open full screen** fallback.

## Production portals

- Customer: https://roviq-web-dxv.pages.dev
- Diagnostic: https://roviq-diagnostic-net.pages.dev
- Partner: https://roviq-partner.pages.dev
- Parts: https://roviq-parts-net.pages.dev
- Tow / Valet: https://roviq-tow-net.pages.dev
- Ops: https://roviq-ops.pages.dev
- Core edge: https://roviq-core.admytruk79.workers.dev
- ROVIQ Local map: https://roviq-local2.admytruk79.workers.dev

## Demo accounts

Do not store demo passwords in this repository.

Create accounts through GitHub Actions before the meeting:

1. Run **Provision ROVIQ Production Accounts** for a Customer account and a dedicated staff/admin account if needed.
2. Run **Provision ROVIQ Role Portal Account** separately for Diagnostic, Tow, Partner, and Parts.
3. For the Diagnostic or Tow account used for the on-site-repair branch, select `enable_field_service=true`. This provisions the verified Field Service profile through Core's admin API and verifies it after login.
4. Test every credential once before the meeting.

Recommended meeting setup:

- Device/browser A: Customer
- Device/browser B: Diagnostic / Field Response
- Device/browser C: Ops or Tow
- Optional browser tabs: Partner and Parts

Use separate browser profiles or incognito windows for different roles so local-storage sessions do not overwrite each other.

## Fast partner-demo scenario

### 1. Customer creates a real case

1. Open Customer from the launcher or full-screen portal.
2. Sign in with the demo Customer account.
3. Create a maintenance/service case.
4. Allow precise location when prompted.
5. Show the case detail screen and explain that this becomes the customer's single service journey.

Expected proof:

- case exists in Core;
- current status and next action are visible;
- canonical location is attached;
- live service map is ready to receive provider position.

### 2. Ops dispatches Diagnostic

1. Open Ops.
2. Find the new case.
3. Move/confirm it into the Diagnostic stage if required by the scenario.
4. Assign the demo Diagnostic provider.

Expected proof:

- Diagnostic receives the case in its queue;
- assignment remains scoped to that provider.

### 3. Diagnostic accepts and shares live position

1. Open Diagnostic on a location-capable phone.
2. Accept the assignment.
3. Allow precise location.
4. Show the Diagnostic live route/map.
5. Refresh or wait for Customer live polling and show the technician marker on the Customer map.

Expected proof:

- Diagnostic GPS is published only for its accepted case;
- Customer sees the privacy-filtered live responder location;
- internal telemetry is not exposed to Customer.

### 4A. On-site repair branch

Use this branch when demonstrating Field Response / Tow + Diagnostic convergence.

1. Diagnostic records the finding.
2. Choose **Assess for on-site repair**.
3. Complete the Field Service assessment: repair class, drivability, confidence, safety flags, required capability/tool/parts information.
4. Submit the assessment.
5. Core decides the authoritative action.

If Core returns `field_repair` with customer authorization required:

1. On the Customer case, show the **Approve on-site repair / Decline** card.
2. Approve.
3. On Tow / Field Operations, show the Core decision card.
4. Start the approved repair.
5. Mark fixed when complete.

Expected proof:

- technician cannot self-authorize unsupported repair;
- safety/capability/parts/customer-approval gates remain authoritative;
- the same qualified Field Response provider can continue across Diagnostic and Tow capabilities.

### 4B. Tow branch

Use this branch when demonstrating movement and same-provider continuity.

1. Diagnostic records a non-drivable or tow-required outcome.
2. Core transitions to Tow.
3. If the same actor is Tow-capable, Core can preserve provider continuity while still requiring the Tow assignment to be accepted.
4. Accept in Tow / Valet.
5. Progress: en route → arrived → vehicle loaded → in transit → delivered.
6. Show Tow movement on the Customer live map.

Expected proof:

- Customer map switches from Diagnostic marker to Tow / Valet context;
- transport ownership and status remain assignment-scoped.

### 5. Partner repair, quote, Parts, approval and payment

1. Partner accepts the repair work.
2. Partner sends a Customer quote.
3. If a part is required, submit the Parts request.
4. Parts supplier stocks/reserves/orders/ships/delivers the part through the existing fulfilment lifecycle.
5. Customer approves the active quote.
6. Ops completes the payment handoff/capture.
7. Show the Customer case reaching completion.

Expected proof:

- one case spans Customer, Diagnostic, Tow, Partner, Parts and Ops;
- Parts state is real, not advisory text;
- stale approvals are rejected;
- Customer sees a sanitized timeline and clear next action.

## Field-service required-parts branch

When the Field Service assessment requires an unavailable part:

1. Core creates the normal case-linked Parts order.
2. The decision remains non-executable while the part is unavailable.
3. Supplier fulfilment proceeds through the normal Parts lifecycle.
4. When the linked order is delivered, Core re-checks current operator eligibility.
5. If still eligible, the waiting decision becomes field-repair eligible and moves to Customer authorization when required.
6. Starting the repair recognizes the delivered linked order and does not reserve inventory a second time.

This is a useful deeper demo if the audience wants to see coordination rather than only dispatch.

## What to say about AI

ROVIQ Core remains the authority. AI-assisted signals are advisory/shadow unless an explicitly permitted policy path exists. For a live partner demo, emphasize deterministic coordination, assignment integrity, capability checks, location continuity, Parts fulfilment, approval and auditability rather than presenting AI as autonomous diagnosis.

## Device and browser checklist

Before the meeting:

- allow location for Customer, Diagnostic and Tow devices;
- confirm each production portal renders on the exact devices you will use;
- confirm the launcher embeds Customer and Diagnostic, and use **Open full screen** if a browser blocks cross-origin storage or device permission inside an iframe;
- keep devices charged and disable battery-saving modes that may suspend location updates;
- use a stable mobile data or Wi-Fi connection;
- test browser Back, refresh, sign-out and re-login once for every role being demonstrated.

## Recovery during a live demo

If a portal appears stale:

1. use its visible **Refresh** action;
2. if embedded in the launcher, use **Open full screen**;
3. re-open the exact case from the role's queue/history;
4. do not create a duplicate case unless the original case is genuinely unusable.

If device GPS is denied, the workflow should continue without fabricating location. Re-enable browser location permission and refresh the case/assignment.

If a provider declines a Tow assignment, demonstrate that the dispatch is released for reassignment rather than manually editing ownership.

## Automated gates to check before a meeting

The latest `main` should have green results for:

- CI;
- Smoke Production Surfaces;
- Smoke ROVIQ Production Browser;
- full credentialed production lifecycle when repository credentials are available;
- relevant portal deploy workflows.

The production browser gate captures screenshots/evidence artifacts for 14 days.

## Demo success criteria

A partner-ready demo is successful when the audience can see, without developer console intervention:

1. a Customer create a real case;
2. a field provider receive and accept assigned work;
3. live provider movement appear to the Customer;
4. Core decide the next service action;
5. Customer approve work when required;
6. Tow or Field Repair execute through visible controls;
7. Partner/Parts fulfilment operate on the same case;
8. quote/payment/completion return to the Customer journey;
9. role boundaries remain intact throughout.
