# Full-case and connection simulation

Run with Node 24, no dependency installation or network required:

```sh
node tests/run-simulations.mjs
```

Seventy scenarios passed on 18 October 2026 across the combined runner, including the original fifteen case, connection and integration-access scenarios. The test executes Core network-execution, capacity-reservation and integration-gateway functions retrieved at revision db76017b33c9846eac3a0344fa75e69fa07ae6e8, including the local integration authentication fix described below. Node transforms the TypeScript. Database and external transport boundaries are replaced.

Integration authentication now rejects revoked keys and inactive/missing actors, and uses a guarded usage update to recheck client/actor state and return current scopes. Six access regression scenarios cover success, revocation, disabled actor, missing actor/inactive client, tampered key, and an invalidation observed at the usage update. The SQL execution and real concurrency are mocked; the guarded update does not guarantee revocation against a transaction committing after its snapshot. Authorization must still be enforced on each actual operation.

The full case starts with mock customer/vehicle/case/plan fixtures, then runs diagnostic assignment/completion, shop capacity reservation and acceptance, towing, mock customer approval, parts arrival, shop completion, completion snapshot and capacity consumption. It demonstrates completion guards and coordination logic. It does not exercise HTTP intake, actual repair-order estimates/DVI/time tracking, authentication, real SQL constraints, concurrent transactions, provider integration, persistence after restart, mileage, payment or UI behavior. See the historical build audit for those separate evidence categories.

Additional scenarios: duplicate logical requests; offline bay, stale capacity, paused connection, exhausted capacity; a second case competing for a held unit and reuse after cancellation; declined provider/failed tow and recovery latch; mobility return blocking completion.

Connection scenarios run the actual outbound webhook worker: HMAC verification and a 503 retry preserving event identity/payload; a timeout becoming a dead letter at the final attempt; response lost after acceptance handled by a mock receiver that deduplicates by event ID. The last test proves the required integration contract, not that arbitrary partner receivers already follow it. SQL backoff is checked as positive, but the fixture makes the retry due immediately and does not test scheduler timing. PostgreSQL row locking/concurrent worker safety is not emulated.

The generated artifacts/full-case-simulation.json contains scenario results and a readable journey transcript. No credentials, real customer data, network requests, charges or production writes are used.

## Useful hardening now

1. Require each inbound/outbound adapter to preserve a stable event/operation ID across retries; test receiver deduplication and timeout-after-success explicitly.
2. Test signature verification, replay windows, revocation, actor status, tenant scope and payload audience before enabling independent companies.
3. Add claim ownership/fencing to prevent an expired worker lease from overwriting a later worker's result. Prove with a real database concurrency test.
4. Separate provider acceptance from delivered/read status. Show disabled configuration, transient failure, uncertain outcome and dead-letter recovery distinctly.
5. Require current verified capacity and usable resources for native shops. Block routing when connections are paused, stale, revoked or degraded unless an explicit verified fallback applies.
6. Review the no-fulfillment-plan completion shortcut using persisted constraints/handoffs. The current successful mock always creates a plan; it does not conceal the shortcut documented by network-integrity.node.test.mjs.

Next gate: run the existing full backend suite on isolated PostgreSQL, then repeat the service-day browser journey with normal accounts for separate organizations and real provider sandboxes. The complete source has now been recovered and reconciled with upstream 505f3d7a14343f6735659356b6ba859fbfcb7f7a. Dependency installation is still blocked by the environment proxy. Full CI and field acceptance remain release gates. See IMPLEMENTATION-STATUS.md.
