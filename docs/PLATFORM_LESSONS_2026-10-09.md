# Platform lessons applied to ROVIQ Core — 2026-10-09

## Sources inspected
- Odoo repair orders: https://www.odoo.com/documentation/master/applications/inventory_and_mrp/repairs/repair_orders.html
- ERPNext immutable ledger: https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext
- ASCEND Glyph Studio: packages/glyph-engine/src/integrity.ts
- ASCEND Tesseract: packages/production-orchestrator/src/order-workflow.ts and docs/TESSERACT-CORE-LESSONS.md (local checkout inspected; current remote parity not asserted).

## Concrete translation

| Observed pattern | Core implementation or action | Status |
| --- | --- | --- |
| Odoo links repair work to a customer and serialized asset | Local customer/vehicle references flow from appointment to repair order; intake exposes optional year, VIN and plate; selections show plate or VIN suffix | Intake merged in #90; identifier UI in this change |
| Glyph integrity rejects orphan evidence and invalid values | Composite database foreign keys bind vehicle to customer and organization; service authorization validates location scope before writes | Implemented in migration 086 and local-intake service; PostgreSQL acceptance tests in #90 |
| Tesseract permits only declared production transitions | Preserve Core's existing guarded workflows; saving intake creates records, never implicitly approves an estimate or declares repair complete | Existing workflow principle; no new solver integration claimed |
| Tesseract keeps durable state and events authoritative | Local intake writes customer, optional vehicle and canonical event in one transaction | Implemented in #90 |
| ERPNext preserves original ledger entries and uses reversals | Require explicit corrective events and reversal flows for future standalone billing rather than deleting financial history | Design requirement; standalone billing still unfinished |
| Glyph reports errors separately from warnings | Future readiness screens should separate hard tenant/capacity/approval blockers from advisory data quality warnings | Follow-up; not implemented by this UI change |

## Boundaries and next increments
Optional identity fields do not establish verified ownership or guarantee VIN uniqueness. API validation and tenant constraints remain authoritative. Do not silently deduplicate customers by name or vehicles by make/model. Preserve failed form input for correction.

Next: add vehicles to existing customers, record corrections with audit events, server-side retry idempotency for intake, and standalone estimate delivery/approval. A new optimizer must consume Core's constraints and produce explainable proposals; it must not bypass guarded commands. CI and deployment success do not establish real-shop readiness.
