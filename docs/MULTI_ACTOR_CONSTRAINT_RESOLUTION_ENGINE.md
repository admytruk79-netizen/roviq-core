# ROVIQ Core — Multi-Actor Constraint & Resolution Engine (MACRE)
Status: **Partial implementation: opt-in qualification routing/selection gate and Ops evidence administration; broader engine remains proposed**
Date: 2026-10-22
Parent reference: ROVIQ Platform Master Technical Specification v2.3 (2026-09-18)

## Principle
ROVIQ must identify, anticipate, and coordinate resolution of operational problems at every level of every actor involved in automotive and mobility services. Matching a customer to a provider is necessary but insufficient: the platform must reason over the complete service-delivery chain.

## Actor coverage
Drivers/vehicle owners, diagnostic technicians, mechanics, service shops, dealerships, parts suppliers, tow and transport operators, fleet managers, mobility providers, platform administrators, and future roles. Every actor can have requirements, constraints, dependencies, exceptions, permissions, and resolution paths.

## Canonical technician qualification example
Given a vehicle VIN/configuration and requested repair:
1. Resolve make/model/year/powertrain/system and task characteristics.
2. Determine task-specific qualifications: training, OEM certification where applicable, legally required professional licensing, shop authorization, tooling/software subscriptions, safety constraints and manufacturer-security access.
3. Verify technician and shop evidence, scope, jurisdiction, validity, expiry and source; do not treat informal self-declarations as equivalent to verified credentials.
4. Incorporate bay capacity, parts availability, insurance, travel radius and timing; validate dependencies as a whole.
5. If eligible and feasible, route with an explainable rationale; otherwise expose the exact gaps and permitted alternatives, escalation, training path, authorized facility, or rescheduling.
6. Recheck time-varying constraints before assignment and at job acceptance. Maintain human override with reason codes and immutable audit trail; hard safety/legal requirements cannot be bypassed.

Note: No universal vehicle-specific technician license exists; OEM certifications, regulatory licensing and manufacturer access approvals are distinct and vary by jurisdiction and task.

## Proposed data contracts
Actor; ActorCapability; Credential; CredentialEvidence; CredentialAuthority; CredentialScope; CredentialExpiration; VehicleConfiguration; ServiceTask; TaskRequirement; FacilityCapability; ToolEntitlement; ResourceCapacity; ConstraintEvaluation; DependencyEdge; ResolutionOption; ResolutionCase; HumanDecision; AuditEvent.

## Integration with existing architecture
- Use existing ROVIQ Core identity/organizations, Maintenance domain, Partner Systems Integration Gateway, canonical scheduling/capacity service and ROVIQ Shop OS.
- Normalize partner signals and credential evidence before evaluating eligibility, never hard-code routing to a vendor schema.
- Enforce server-side role/permission boundaries and partner-isolated projections.
- Keep weighting, algorithms, commercial rules and sensitive internal data out of public APIs and pages.
- Support manual/bridge verification during pilot while making verified integrations the target state.

## Proposed workflow
Intake -> vehicle/task identification -> requirement graph -> credential and resource evidence lookup -> constraint evaluation -> feasible-option selection -> human approval where required -> dispatch -> execution checks -> completion evidence -> audit/learning.

## Delivery phases
P0: Define actors, constraints, licensing vs certification distinction, eligibility contract, hard-blocks, evidence provenance, and test fixtures.
P1: Technician/facility qualification gating, exception codes, clear fallback options and admin review integrated with Maintenance routing.
P2: Synchronization of expiring credentials, shop capacity and tool entitlements, plus dependency-aware re-planning.
P3: Broader network-wide multi-actor resolution, proactive gap detection and measurable outcome optimization.

## Acceptance criteria
- Unqualified or unauthorized technician never appears as eligible for gated task.
- Expired or unverified credential is flagged and routed to verification/reassignment.
- Missing required equipment/part/bay prevents false promise of service.
- A qualified alternative and reason for exclusion are traceable.
- Actors only see authorized fields; every decision is auditable.
- No new public claims of automatic qualification verification before operational evidence and implementation testing.

## Latest build snapshot (reviewed 2026-10-22)
The opt-in case qualification tables and deterministic evaluator now feed the serviceability gate. Ops qualification administration adds identified administrator reviews, evidence references, expiry, revocation, version conflicts and atomic audit history. See [qualification administration](qualification-administration.md) for its tested scope and limits. Requirements must still be explicitly registered; automatic VIN/task inference, issuer integrations and universal dispatch/acceptance enforcement remain outstanding.

### Earlier source-history snapshot
Repository: https://github.com/admytruk79-netizen/roviq-core
Most recent commit observed: 6fcd1bf223603afe1037cd91769ecabccb8fc8d8 — "Add Ops onboarding for independent business accounts" (2026-10-22 05:29 UTC).
Earlier observed: e728179b804aa878f1d5912694377d94383863f3 — customer actions with empty request bodies; d9d47a72ca396cc2342b0e202479feb176448aba — vehicle-care dropdown matching browser checks.
This is a source-history snapshot only: production deployment, tests and MACRE implementation **not verified**. The MACRE section is a proposed addition, not evidence it exists in code.
