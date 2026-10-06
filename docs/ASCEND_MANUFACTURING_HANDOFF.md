# ASCEND -> ROVIQ Manufacturing Handoff

ASCEND remains authoritative for the paid design and immutable production package. ROVIQ becomes authoritative for operational execution after handoff.

Boundary:
ASCEND package-generated -> ROVIQ manufacturing job -> manufacturer acceptance -> production -> QC -> shipment -> delivery.

The handoff carries design/version, immutable package id + SHA-256, selected eligible manufacturer and capability-profile version. ROVIQ does not copy or reinterpret glyph geometry.

Manufacturing transitions require event id, actor, timestamp and idempotency key and are append-only contract objects. Illegal state jumps fail closed; shipment cannot precede QC.

This adapter is intentionally domain-specific while reusing Core principles: eligibility before selection, immutable events, guarded transitions and reproducible external references.
