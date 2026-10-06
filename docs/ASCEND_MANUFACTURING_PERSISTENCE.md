# Durable Manufacturing Persistence

Migration 075 adds dedicated apparel-manufacturing operational persistence without copying ASCEND design geometry.

- manufacturing_jobs: current operational projection bound to external ASCEND job/design/package hash.
- manufacturing_events: append-only, versioned transition history with per-job idempotency.
- manufacturing_outbox: transactional delivery queue created in the same DB transaction as the state change.

The persistence service locks the job row, validates the domain transition, checks the expected current state, appends the event, advances the projection and writes the outbox atomically. Duplicate idempotency keys do not advance state twice. State conflicts fail closed.

This establishes the durable boundary required before manufacturer webhooks/portal notifications and shipment integrations are connected.
