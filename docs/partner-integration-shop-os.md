# ROVIQ Connect + Shop OS architecture

Status: planned architecture alignment, 2026-09-04.

This document closes the live-capacity gap in the ROVIQ operating model. ROVIQ Core cannot coordinate dealership/shop overflow reliably if capacity is only self-declared or manually reported. Production routing must consume normalized capacity derived from one of three partner operating modes.

## Partner operating modes

1. Native integration mode

For dealerships, dealer groups and mature independent shops that already operate a DMS, SMS, shop-management or scheduling system, ROVIQ Connect acts as a permissioned integration layer. ROVIQ reads and, where authorized, writes only the operational fields required for coordination.

2. ROVIQ-native mode

For smaller shops or partners without an adequate scheduling system, ROVIQ Shop OS becomes the scheduling and capacity system of record. The partner uses ROVIQ to manage appointment windows, bays, technician assignments, job states and availability.

3. Bridge mode

For legacy environments without useful APIs, ROVIQ supports import/manual-sync/calendar bridge workflows until a stronger connector or migration path is justified. Bridge mode is a pilot and compatibility state, not the target production state.

## Canonical flow

Existing partner system -> ROVIQ Connect -> Capacity normalization -> ROVIQ Core -> service case routing.

ROVIQ Shop OS -> Capacity normalization -> ROVIQ Core -> service case routing.

All paths must produce the same canonical capacity model before routing. ROVIQ Core must never route directly against a third-party vendor schema.

## Minimum capacity contract

A normalized capacity signal should be able to answer:

- Which partner location is eligible for the case?
- Which service categories and OEM/warranty boundaries apply?
- Which appointment windows are available?
- Which bay/technician resources are open or blocked, when available?
- Which mobility or loaner constraints affect the case?
- Whether the location has paused or limited routing?
- Whether sync is live, stale, degraded or manually verified?

## Security and partner isolation

Partner integrations remain tenant-scoped. One partner must never receive competitor raw capacity, customer lists, internal queues, pricing configuration or operational metrics. ROVIQ Core may use normalized capacity for eligibility and routing, but exposed partner views must remain authorized projections only.

## Implementation implications

- Add integration connection records for external systems.
- Store external object references separately from canonical Core IDs.
- Record sync state, error state and last successful synchronization.
- Add canonical capacity windows and scheduling resources.
- Add ROVIQ-native scheduling records for partners without an adequate system.
- Preserve immutable events for all capacity, scheduling and integration changes.
- Route only against normalized, policy-filtered capacity.

## Build sequencing

Phase A: data contracts and admin/partner bridge controls.

Phase B: ROVIQ-native scheduling for pilot shops without systems.

Phase C: first native integration adapter for a pilot partner system.

Phase D: bidirectional sync and deeper automation after pilot evidence.
