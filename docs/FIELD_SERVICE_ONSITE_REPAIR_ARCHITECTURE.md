# ROVIQ Field Service / On-Site Repair Architecture

Status: implementation baseline, 2026-09-01

## Purpose

ROVIQ must not force every roadside case into a tow. A vehicle can sometimes be safely restored or stabilized where it is located. Field service is therefore a first-class sub-workflow of the same service case, connected to customer intake GPS, diagnostics, transport, parts, partner capability, customer authorization and operations oversight.

The on-scene operator does not independently choose the commercial or safety outcome. The operator supplies observations and evidence. Diagnostics supplies findings and confidence. Core applies deterministic policy and records the authoritative decision.

## Authority model

1. **On-scene operator** — captures symptoms, photos, OBD/diagnostic data, battery/tire/vehicle observations and tool/part availability.
2. **Diagnostic workflow** — records the diagnostic finding, drivability and whether the case should enter field-service assessment.
3. **ROVIQ Core field-service policy** — checks safety exclusions, confidence, required capabilities, tools, parts and whether the operator is permitted to perform the work.
4. **Customer authorization** — required before chargeable on-site repair or stabilization when configured by the decision.
5. **Core-issued action** — the operational source of truth. Supported actions are `field_repair`, `temporary_stabilization`, `dispatch_field_technician`, `route_to_shop`, `tow_required`, and `remote_review`.
6. **Field operator** — executes only an authorized action and records completion evidence/outcome.
7. **Ops** — handles exceptions, low-confidence cases, unavailable parts/capability, reassignment and escalation.

## Case lifecycle integration

Field service is a sub-workflow attached to `service_cases`; it does not create a second case and does not bypass the main state machine.

Typical path:

`customer intake + GPS -> triage -> diagnostic -> field_service_assessment -> Core decision`

Then one of:

- `field_repair -> customer authorization -> work in progress -> fixed`
- `temporary_stabilization -> customer authorization -> stabilization -> continue approved route`
- `dispatch_field_technician -> specialist assignment -> reassess`
- `route_to_shop -> provider selection / valet`
- `tow_required -> transport dispatch`
- `remote_review -> diagnostic/Ops review -> new decision`

A transport operator who arrives first can contribute evidence and operator capability, but cannot self-authorize unsafe or unsupported repair work.

## Data model

Migration: `migrations/020_field_service_decisions.sql`

`field_service_decisions` stores:

- case, demand and optional diagnostic-finding links;
- Core-issued action and decision status;
- repair class and drivability;
- diagnostic confidence;
- safety flags;
- required capabilities, tools and parts;
- operator capability/tool/parts context;
- evidence;
- estimated time and cost;
- customer authorization requirement and timestamp;
- execution start/completion and outcome;
- audit metadata.

The decision record is append-oriented: new assessments produce new decisions rather than silently rewriting diagnostic history.

## API contract

### Read decisions

`GET /api/maintenance/cases/:id/field-service`

Returns the case field-service decision history subject to normal case access control.

### Assess field service

`POST /api/maintenance/cases/:id/field-service/assess`

Roles: diagnostic, tow, partner, admin.

Inputs include repair class, drivability, confidence, safety flags, required capabilities/tools/parts, operator capabilities/tools, part availability, estimate and evidence.

Core computes the action. The client does not send the authoritative action.

### Customer authorization

`POST /api/maintenance/cases/:id/field-service/:decisionId/authorize`

Roles: customer or admin. Sets `authorized` or `declined`.

### Start approved work

`POST /api/maintenance/cases/:id/field-service/:decisionId/start`

Roles: diagnostic, tow, partner, admin. Start is rejected if customer authorization is required but absent, or if the Core action is not executable on site.

### Complete work

`POST /api/maintenance/cases/:id/field-service/:decisionId/complete`

Records `fixed`, `stabilized`, `failed`, or `escalated`, plus evidence and notes.

## Deterministic safety policy baseline

The first policy version intentionally errs toward escalation.

- Any fire risk, fuel leak, high-voltage risk, brake/steering risk, unstable vehicle or unsafe roadside condition -> `tow_required`.
- `non_drivable` -> `tow_required`.
- Diagnostic confidence below 0.75 -> `remote_review`.
- Operator cannot perform work -> `dispatch_field_technician`.
- Missing required capability/tool -> `dispatch_field_technician`.
- Required part unavailable -> `dispatch_field_technician`.
- Unknown repair class -> `remote_review`.
- Otherwise -> `field_repair`, with customer authorization where required.

These rules are a safety floor, not a final clinical/technical diagnostic model. Policy versions can become more granular by repair class after supervised evidence is available.

## Diagnostic integration

`diagnostic_findings.disposition` now supports `field_service_assessment`.

This disposition keeps the case in the diagnostic work context while signaling that the next authoritative step is a field-service decision. The diagnostic frontend should surface this as **Assess for on-site repair** rather than treating it as an automatic repair instruction.

Diagnostic tools should attach structured evidence to the finding and/or field-service assessment, including where available:

- OBD codes and freeze-frame data;
- battery voltage/charging readings;
- tire pressure/damage observations;
- visual evidence;
- symptoms and test results;
- confidence and uncertainty;
- safety exclusions.

## Transport integration

Transport remains an execution pathway, not the repair authority.

- New dispatches inherit the canonical case pickup location from `case_spatial_context` or the case intake GPS when a pickup was not explicitly supplied.
- A declined assignment is released back to `requested`, clears the provider link and case transport owner, and becomes eligible for reassignment.
- The declining provider no longer owns or sees the released dispatch in their personal queue.
- Tow/Valet can participate in field-service assessment when the operator is physically present, but Core controls the resulting action.

## Parts integration

Field-service assessment records required parts and whether they are available. The next implementation layer should connect `required_parts` to the existing parts fulfilment system so a field repair can reserve/dispatch a part without opening a second case.

No on-site repair should start merely because a part name was entered by a client. Part availability must be confirmed by Core/parts fulfilment.

## Customer experience

The customer should see one understandable case status:

- assessment in progress;
- on-site repair available — approval required;
- on-site work authorized;
- repaired on site;
- stabilized — next step required;
- specialist being dispatched;
- tow required;
- further review required.

The customer should never be asked to interpret diagnostic codes to make the routing decision.

## Tow / Field Operations UI contract

The Tow/Valet surface should evolve into a Field Operations surface without merging role permissions.

For the active case it should show:

- live pickup/destination and vehicle/tow GPS;
- latest diagnostic summary and confidence;
- latest Core field-service action;
- a compact **Assess on site** entry point when eligible;
- **Request customer approval** / authorization state;
- **Start approved repair** only when Core permits it;
- **Complete / stabilized / failed — escalate** controls;
- transport controls when the Core action is tow/valet.

The driver must not see a generic “fix vehicle” button before a Core decision exists.

## Audit and safety requirements

Every assessment, authorization, start, completion and escalation produces an immutable case event or audit record. Safety-critical policy remains deterministic. AI or diagnostic automation may propose evidence or classification but cannot bypass safety flags, capability checks or required customer authorization.

## Release verification required

Before field repair is production-enabled, add automated and supervised tests for:

1. unsafe case always routes to tow;
2. low-confidence diagnosis always routes to review;
3. unqualified operator cannot start repair;
4. missing tool/part prevents field repair;
5. customer authorization blocks start when required;
6. authorized repair can start and complete;
7. failed repair escalates without orphaning the case;
8. tow decline releases the dispatch and permits reassignment;
9. dispatch inherits customer intake GPS;
10. role isolation prevents unrelated operators from reading or mutating field-service decisions.
