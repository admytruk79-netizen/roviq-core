# ERP and SCM decision gates

ASCEND's [glyph engine](https://github.com/admytruk79-netizen/ascend-glyph-studio/blob/main/docs/ARCHITECTURE.md) assembles a canonical version, runs hard validation, proposes a production plan, and requires separate approval and physical evidence before release. ROVIQ Core uses the same shape for service cases and provider routing. The portable principle is to keep **evaluation, recommendation, commitment, and evidence** distinct.

| Stage | ASCEND example | ROVIQ Core example | Generic ERP/SCM use |
| --- | --- | --- | --- |
| Immutable input | Locked design and BOM revision | Case, parts order and policy version | Order/BOM revision with source provenance |
| Hard eligibility | Canonical glyph and manufacturer capabilities | Tenant permission, active supplier, full-SKU available inventory | Approved vendor, stock, quality and regulatory gates |
| Soft choice | Candidate objectives and manufacturability scores | Ranked supplier signals under active policy | Cost, lead time, reliability and capacity tradeoffs |
| Preview | Operational plan | `GET /api/admin/parts-orders/:id/supplier-plan` | Planned PO/WO, with no stock mutation |
| Commit | Approved manufacturing job | Supplier assignment, then transactional reservation | Firm a PO/WO only after fresh validation |
| Evidence | Sample, QC and delivery events | Parts status, case event, audit and reconciliation | Receipt, lot, QC, shipment and invoice trail |

The new supplier-plan endpoint is admin-only and read-only. It shows the policy version, observation time, candidate count, ranked alternatives and recommendation. It never reserves inventory. Inventory is volatile; the later reservation remains the authoritative stock gate. Operators should refresh the preview before assignment and treat any changed candidate or failed reservation as a new decision.

This is consistent with real systems: [Dynamics 365 separates planned orders from firming](https://learn.microsoft.com/en-us/dynamics365/supply-chain/master-planning/planning-optimization/planned-order-firming) and warns that uncritical firming creates unwanted orders; [Odoo distinguishes replenishment suggestions from PO/MO generation](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment.html). Their implementations differ, but the planning/commit boundary is useful for ROVIQ's service, parts and manufacturing domains.

Next: show the preview and its constraints in Ops, add a fresh-inventory recheck to supplier assignment where it is presented as fulfillable, and capture the winning plan snapshot with any assignment. Do not treat an advisory preview as a guaranteed reservation.
