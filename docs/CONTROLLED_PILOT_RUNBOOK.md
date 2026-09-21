# ROVIQ Controlled Shop OS Pilot Runbook

This runbook defines how to execute the first controlled ROVIQ-native Shop OS pilot without bypassing Core, the canonical Service Case, or production safety/financial controls.

## Entry gate

Use the Ops **Pilot** screen or:

`GET /api/admin/pilot/readiness?organizationId=<id>&locationId=<id>`

Do not begin live pilot traffic unless `ready=true`.

The readiness gate currently requires:

- active pilot organization,
- concrete owned location,
- active `roviq_native` connection,
- at least one usable bay,
- at least one usable technician,
- at least one current future capacity window with positive usable units,
- at least one externally configured notification provider,
- Stripe API + webhook configuration.

Warnings surface degraded capacity, unavailable resources, settlement-destination gaps, operational exceptions, and dead webhooks. Warnings do not automatically block a pilot, but an operator must understand and accept them before starting.

## Create the pilot record

After readiness passes, create an auditable run from Ops or:

`POST /api/admin/pilot/runs`

with the pilot organization/location.

The run is created as `ready` and stores the exact readiness snapshot used at creation.

Only one `ready` or `active` pilot run can exist per location.

## Start

Start from Ops or:

`POST /api/admin/pilot/runs/:id/start`

Core re-evaluates pilot readiness immediately before the transition to `active`. If a required dependency has degraded since creation, the start fails closed.

## Live workflow to exercise

Use real operational data appropriate for the authorized pilot scope and exercise the supported path end to end:

1. Customer/service demand enters Core.
2. Canonical Service Case is created.
3. Shop/dealership is selected through the allowed orchestration path.
4. Appointment is held and confirmed against canonical capacity.
5. Bay/technician capacity remains conflict-safe.
6. Repair Order is created from the case/appointment.
7. DVI/findings are recorded where applicable.
8. Estimate/approval is exercised.
9. Required parts are declared and readiness is updated.
10. If needed, transport/valet is coordinated.
11. If needed, mobility/loaner is coordinated.
12. Customer notifications are actually delivered through the configured provider.
13. Work progresses through WIP to completion.
14. Payment is created through the real provider path.
15. Provider webhook proves capture/refund/dispute state as applicable.
16. Partner settlement is executed where the commercial pilot requires it.
17. Financial reconciliation is reviewed.
18. Case completion is recorded without unresolved canonical blockers.

Do not replace a failed ROVIQ workflow with an untracked spreadsheet, text thread, private calendar, or paper workaround. If a workaround becomes operationally necessary, record the gap and abort or pause the pilot as appropriate.

## Required completion evidence

The Ops pilot screen requires operator confirmation of:

- scheduling,
- repair order,
- notifications,
- payments,
- reconciliation.

The backend retains this evidence with the pilot run. Add more evidence in the API payload when relevant, such as case IDs, repair-order IDs, payment IDs, timestamps, incident references, or measured durations. Do not store secrets or raw payment credentials in pilot evidence.

## Abort conditions

Abort the controlled run when a material blocker appears, including:

- tenant/isolation failure,
- double booking or capacity corruption,
- authorization/safety bypass,
- canonical data loss or conflicting ownership,
- notification delivery failure that cannot be recovered,
- financial mismatch or unproven settlement,
- unrecoverable connector degradation,
- operational work requiring an untracked parallel system.

Use:

`POST /api/admin/pilot/runs/:id/finish`

with `outcome="aborted"` and an explicit reason.

## Pilot metrics

Capture at minimum:

- demand received,
- demand recovered / successfully served,
- time to first actionable plan,
- time to confirmed appointment,
- time to diagnosis,
- parts-wait time,
- transport/mobility usage,
- total vehicle downtime,
- completion time,
- notification delivery latency,
- approval latency,
- payment success/failure/refund/dispute,
- partner settlement status,
- exception count,
- manual intervention count,
- any use of fallback/Bridge mode,
- repeat-contact/rework incidents.

The first pilot is intended to validate operational truth and workflow integrity, not maximize volume.

## Completion

Mark the run `completed` only after the required workflows have been exercised and reconciliation is clean enough to support the retained evidence.

After completion:

1. review the pilot run evidence,
2. review open exceptions,
3. review notification/webhook dead letters,
4. run financial reconciliation,
5. inspect connector health,
6. inspect fulfillment recovery state,
7. record defects and workflow gaps,
8. decide what must be fixed before increasing pilot volume.

Completion of one pilot run is not equivalent to declaring the entire platform production-ready.
