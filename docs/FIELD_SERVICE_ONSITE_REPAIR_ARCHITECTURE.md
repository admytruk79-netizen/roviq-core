# ROVIQ Field Service / On-Site Repair Architecture

Status: implementation baseline, 2026-09-01

## Purpose

ROVIQ must not force every roadside case into a tow. A vehicle can sometimes be safely restored or stabilized where it is located. Field service is therefore a first-class sub-workflow of the same service case, connected to customer intake GPS, diagnostics, transport, parts, partner capability, customer authorization and operations oversight.

The on-scene operator does not independently choose the commercial or safety outcome. The operator supplies observations and evidence. Diagnostics supplies findings and confidence. Core applies deterministic policy and records the authoritative decision.

## Authority model

1. **On-scene operator** captures symptoms, photos, OBD/diagnostic data and observations.
2. **Diagnostic workflow** records finding, drivability and whether the case enters field-service assessment.
3. **ROVIQ Core field-service policy** checks safety exclusions, confidence, verified operator capability/tools and required parts.
4. **Parts fulfilment** is authoritative for availability. Clients do not self-declare that a part is available.
5. **Customer authorization** is required before chargeable on-site repair or stabilization when configured.
6. **Core-issued action** is the operational source of truth: `field_repair`, `temporary_stabilization`, `dispatch_field_technician`, `route_to_shop`, `tow_required`, or `remote_review`.
7. **Field operator** executes only an authorized action and records completion evidence/outcome.
8. **Ops** handles exceptions, low-confidence cases, unavailable parts/capability, reassignment and escalation.

## Case lifecycle integration

Field service remains a sub-workflow attached to `service_cases`; it does not create a second case.

`customer intake + GPS -> triage -> diagnostic -> field_service_assessment -> Core decision`

Then one of:

- `field_repair -> customer authorization -> inventory reservation -> work in progress -> fixed`
- `temporary_stabilization -> authorization -> inventory reservation where required -> stabilization -> next approved route`
- `dispatch_field_technician -> specialist assignment -> reassess`
- `route_to_shop -> provider selection / valet`
- `tow_required -> transport dispatch`
- `remote_review -> diagnostic/Ops review -> new decision`

## Data model

Migration: `migrations/020_field_service_decisions.sql`

`field_service_decisions` stores case/finding links, Core action, repair class, drivability, confidence, safety flags, required capabilities/tools/parts, verified operator context, evidence, estimates, customer authorization, execution state and outcome.

Verified field capability profiles are stored separately and administered by Core. An operator cannot self-declare qualification at execution time.

## Parts integration

Field-service assessment accepts required parts as structured `{sku, quantity, partNumber?, description?}` items.

Core queries `parts_inventory` and identifies an active supplier that can satisfy the complete required set. If the parts cannot be fulfilled, Core does not authorize field repair; the decision escalates to field technician / alternate fulfilment.

When approved work starts, Core reserves the required inventory transactionally by incrementing `quantity_reserved` under row locks. If stock changed after assessment and reservation can no longer be made, start is rejected with a parts-unavailable conflict rather than allowing unsupported work.

This prevents two field jobs from consuming the same inventory and removes the former client-controlled `partsAvailable` boolean from the decision authority path.

## API contract

- `GET /api/maintenance/cases/:id/field-service` — decision history.
- `POST /api/maintenance/cases/:id/field-service/assess` — diagnostic/tow/partner/admin assessment; Core computes the action.
- `POST /api/maintenance/cases/:id/field-service/:decisionId/authorize` — customer/admin approval.
- `POST /api/maintenance/cases/:id/field-service/:decisionId/start` — rechecks operator authority and reserves parts before work begins.
- `POST /api/maintenance/cases/:id/field-service/:decisionId/complete` — fixed/stabilized/failed/escalated result.

## Deterministic safety baseline

- Fire, fuel leak, high-voltage, brake/steering, unstable vehicle or unsafe roadside -> `tow_required`.
- Non-drivable -> `tow_required`.
- Confidence below 0.75 -> `remote_review`.
- Unknown repair class -> `remote_review`.
- Unverified/insufficient operator capability or tools -> `dispatch_field_technician`.
- Required parts unavailable in Core inventory -> `dispatch_field_technician`.
- Otherwise -> `field_repair`, subject to customer authorization where required.

## Transport integration

Transport remains an execution pathway, not repair authority.

- New dispatches inherit the canonical case pickup location from `case_spatial_context` or intake GPS.
- A declined assignment is released back to `requested`, provider ownership is cleared, and it can be reassigned.
- The declining provider no longer owns the released dispatch in their personal active queue.
- Tow/Valet can contribute assessment evidence while physically present, but Core controls the resulting action.

## Tow / Field Operations UX contract

The Tow surface is a driver workspace, not a dashboard wall.

The default **Drive** view contains only:

- active assignment summary;
- one primary operational action plus one secondary action when needed;
- compact Core field-service decision when one exists;
- live route map.

The map carries only the route instruction, ETA/distance/speed, location control and map mode. Duplicate ROVIQ branding, duplicate warning cards and always-visible four-cell spatial summaries are removed. Pickup/destination/tow coordinates are available under collapsed **Trip details**.

**Queue** is a separate view for active assignments. **History** is a separate view for previous `delivered`, `declined`, `cancelled` and `failed` jobs so previous work remains accessible without cluttering the driving workflow.

## Customer experience

Customer-facing statuses remain simple: assessment, approval required, authorized, repaired on site, stabilized, specialist being dispatched, tow required or further review required. Customers are not asked to interpret diagnostic codes.

## Audit and release verification

Every assessment, authorization, inventory reservation, start, completion and escalation must remain traceable to the case.

Before production field repair is enabled, verify unsafe routing, low-confidence review, capability blocking, parts lookup/reservation contention, customer authorization, successful completion, failed-repair escalation, tow reassignment, inherited GPS, role isolation, active queue/history separation and mobile driver usability.
