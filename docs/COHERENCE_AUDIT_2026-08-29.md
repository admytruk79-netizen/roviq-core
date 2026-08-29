# ROVIQ System Coherence Audit — 2026-08-29

## Purpose

This audit tests whether the current product concept, business plan, topology, data model, actor model, orchestration, AI, routing, Coordination Engine, ROVIQ Local integration and planned GIS layer are converging on one product goal.

**Reference product goal:** make the handoff itself the product — one controlled automotive-service journey across independent providers, while preserving partner control, customer choice where appropriate, sensitive-data isolation, and an auditable case history.

## Executive finding

ROVIQ is directionally coherent, but it is not yet fully coherent in implementation.

The strongest unifying element is the **service case**. The weakest areas are the boundaries between multiple internal “engines,” incomplete operational geography, incomplete partner subtype modeling, generic map embeds, and a few places where implementation can drift from the commercial promise of controlled customer choice and dealership continuity.

The correct architectural interpretation is:

> **One ROVIQ Engine** is the product-level coordination system. AI Triage, deterministic safety, routing policy, Coordination Engine, spatial/GIS logic, workflow orchestration and event/audit services are internal subsystems — not competing engines and not independent decision makers.

## 1. Business idea vs implementation

### Coherent

- Business positioning: multiple front ends, one coordinated backend, one ROVIQ engine.
- Core implementation: one authoritative case-centered backend with role-specific apps.
- Business problem: fragmented diagnosis, repair, tow/valet, parts and mobility handoffs.
- Core model: service case links those same workflows.
- Business promise: sensitive operating information is isolated.
- Core model: server-side principal/actor and case access controls are fail-closed.
- Business model: asset-light coordination of partner-owned capacity.
- Core implementation: capacity, capabilities, partner controls, routing and assignments represent external actors rather than ROVIQ-owned service assets.

### Gap

The implementation language now contains several named “engines” (AI triage, Coordination Engine, future Spatial/GIS Engine). If these are treated as separate authorities, the product becomes architecturally incoherent.

### Resolution

Use **ROVIQ Engine** as the only product-level engine. Internally document these as modules:

1. Case Orchestrator
2. Safety & Rules Module
3. AI Intelligence Module
4. Eligibility & Policy Module
5. Coordination Ranking Module
6. Spatial Intelligence Module
7. Commerce & Settlement Module
8. Events, Notifications & Audit Module

No module may independently commit a business outcome that belongs to Core orchestration.

## 2. Case model coherence

### Strong

`service_cases` is the correct central aggregate. It gives one identity to the full service journey and supports state, drivability, customer ownership, current operational owner, market/location, attributes, links, deadlines, exceptions and audit/event history.

This matches the business promise: **one case, multiple providers, one coordination history**.

### Required discipline

Every operational object must either:

- be directly keyed by `case_id`, or
- be linked through `case_links`, or
- be a network-level object that is explicitly consumed by a case decision.

No role portal should invent a parallel “job” truth outside the case.

## 3. Actor coherence

### Actors that fit the model

- Customer / driver
- Dealership
- Independent repair shop
- Service center
- Mobile service provider
- Diagnostic provider
- Tow / valet provider
- Parts vendor
- Mobility / fleet provider
- Admin / Ops

These actors directly match the business problem and the required handoffs.

### Current structural gap

The shared `partner` role is too broad to carry all commercial meaning by itself. Dealerships are the launch wedge and are commercially different from independent shops. Mobile providers also have materially different geography and capacity semantics.

### Required model

Identity -> Organization Membership -> Actor -> Actor Type -> Partner Subtype -> Capabilities -> Controls -> Capacity -> Market/territory.

Minimum partner subtypes:

- dealership
- independent_repair
- service_center
- mobile_service

Tow, diagnostics and parts should remain distinct operational roles even though they participate in the same network.

Mobility/fleet is a valid actor even without a dedicated commercial frontend at launch.

## 4. Dealership-first strategy coherence

### Business requirement

The launch wedge is dealership service departments. The value is customer retention, controlled overflow, capacity relief and mobility continuity.

### Current risk

Generic “best provider” routing can accidentally turn ROVIQ into a marketplace that routes customers away from the dealership rather than a continuity platform anchored by the originating dealer relationship.

### Required routing context

A case should be able to carry:

- originating organization / dealership
- relationship owner
- overflow permission
- eligible network scope
- competitor exclusions if contractually permitted
- return-to-origin preference
- mobility continuity requirements

The originating dealership must remain visible in the case relationship even when work moves to another provider.

## 5. Customer choice vs auto-selection

### Business requirement

Customer choice can remain available among eligible options. ROVIQ coordinates around that choice.

### Current implementation

The routing service ranks eligible actors and currently stores the first ranked actor as `selected_actor_id`.

### Coherence risk

A ranking winner is not always equivalent to a customer-authorized provider selection.

### Required distinction

Core should distinguish:

- `recommended_actor_id` — system ranking result
- `selected_actor_id` — provider actually selected under policy/workflow
- selection mode: `customer_choice | sponsor_choice | dealer_controlled | auto_dispatch | ops_override`

Tow/emergency dispatch may legitimately auto-select. Planned repair overflow may require customer choice. Dealership contracts may define a controlled selection mode.

This distinction is important for commercial, legal and UX coherence.

## 6. AI coherence

### Correct role

Workers AI performs structured interpretation of symptoms and proposes capabilities, drivability, safety flags, evidence, confidence, missing information and suggested actions.

### Correct safeguards

- deterministic critical-safety rules override model suggestions
- AI does not make definitive diagnosis
- AI does not choose providers
- low-confidence/critical cases require human review
- assessments are persisted and auditable

### Coherence conclusion

AI fits the system when treated as **case intelligence**, not a separate control plane.

### Topology concern

The Cloudflare Worker currently executes AI and writes AI assessment records directly to Neon, while Fastify Core is otherwise described as the authoritative business backend.

This is operationally workable, but it creates a second write path into the system of record.

### Preferred target

Cloudflare executes the model; Core owns the canonical persistence/audit command. If direct edge writes remain for latency or deployment reasons, they must be restricted to AI-assessment tables and must not perform case transitions, assignments or commercial actions.

## 7. Coordination Engine coherence

### Correct role

The Coordination Engine is a deterministic ranking module layered over runtime policy. It evaluates eligible candidates using base policy score plus bounded relationship adjustments.

### Strong properties

- deterministic
- seeded tie-breaking
- bounded adjustments
- interpretable relationships
- traceable base score and final score
- cannot make an ineligible actor eligible

### Current incomplete signals

`distanceMiles` and `etaMinutes` are still null in maintenance routing.

`continuity` is currently zero.

Therefore spatial and relationship continuity logic exists structurally but is not yet operational.

### Coherence conclusion

The module is architecturally sound but only partially activated.

## 8. Spatial / GIS coherence

### Why GIS belongs

The business problem is fundamentally geographic: the customer, vehicle, diagnostic technician, repair capacity, tow provider, parts source and replacement mobility all exist in physical space.

### Required role

Spatial intelligence should supply facts to Core:

- distance
- drive time
- ETA
- service territory eligibility
- pickup/destination geography
- geofence events
- coverage gaps

It should not become a separate routing authority.

### Correct flow

Case -> Eligibility -> Spatial facts -> Runtime policy -> Coordination ranking -> governed selection.

### Current gap

The system has a Local adapter and map surfaces, but operational case geography is not yet a first-class shared contract.

## 9. ROVIQ Local coherence

### Correct role

ROVIQ Local is a geographic discovery/community product and reusable spatial substrate.

### Incorrect role

ROVIQ Local should not be used as a generic operational map inside every role portal.

### Required boundary

Local supplies geographic services such as geocoding/route/place context. Core merges those services with authorized case data and returns role-specific spatial projections.

Sensitive case data must not be pushed into a public Local experience.

## 10. Frontend coherence

### Customer

Should see one case journey, relevant choices, next action, approvals, ETA, movement and payment.

### Diagnostic

Should see assigned diagnostic cases, symptoms, evidence, location and handoff actions.

### Partner

Should see assigned/eligible service work, diagnostic summary, scope, capacity, arrival, parts and service state.

### Parts

Should see case-linked item demand, fitment/reference, availability, fulfillment and destination.

### Tow / Valet

Should see dispatch-specific pickup, destination, route, vehicle, handoff and status — not a broad Local map.

### Ops

Should see the broad network: active cases, exceptions, assignments, movement, dependencies and decision traces.

### Current conclusion

Role separation is conceptually correct. Generic Local map embeds are the clearest current frontend coherence defect.

## 11. Mobility coherence

Replacement mobility belongs in the business promise and workflow because a repair case can fail commercially even if the repair is correctly routed when the customer cannot remain mobile.

The current fleet/mobility backend fits the product. It does not need a standalone commercial frontend at launch. Ops can manage it initially, then a dedicated provider surface can be activated when real supply requires it.

## 12. Commerce coherence

### Business model

Revenue is based on:

1. location/platform access
2. completed coordination
3. fulfilled optional services such as diagnostics, tow/valet, mobility and parts

### Core fit

The platform already contains catalog/price/quote/subscription/entitlement/payment/refund/payout/revenue-allocation foundations.

### Gap

The commercial definition of a **completed coordination billing event** must be explicitly connected to case state/event semantics. A raw lead or merely ranked actor must never become the billing event.

### Required rule

Billing event = contractually defined completed case milestone, with immutable event/version evidence.

## 13. Topology coherence

### Current topology

Cloudflare Pages frontends -> Cloudflare Worker edge -> Fastify Core -> Neon.

Cloudflare Worker also executes Workers AI and can persist AI assessments to Neon.

### Conclusion

This remains logically “one coordinated backend” if the authority boundary is explicit.

The system should not be described as microservices. It is better described as a modular Core with an edge execution/gateway layer and shared system of record.

## 14. Orchestration coherence

The state machine broadly matches the intended journey:

intake -> triage -> diagnostic/provider/tow paths -> repair -> parts if needed -> payment -> completion.

This is coherent with the business promise.

The main orchestration enhancement still needed is **selection mode / recommendation vs commitment**, plus dealership-origin continuity and spatial context.

## 15. Engine authority hierarchy

To prevent internal modules from fighting each other, the authority order should be explicit:

1. Authentication & authorization
2. Deterministic safety constraints
3. Case state / workflow guards
4. Contract / sponsor / customer selection rules
5. Capability eligibility
6. Geographic/service-territory eligibility
7. Runtime routing policy
8. Coordination ranking
9. AI advisory intelligence where allowed
10. Human/Ops override with audit

AI never bypasses 1–8. Coordination ranking never bypasses eligibility. GIS supplies facts; it does not override policy. Human override must be explicit and audited.

## 16. Overall coherence score

### Product concept: 9/10

The product idea is clear and differentiated: coordination rather than directory/referral.

### Case/data architecture: 9/10

The case aggregate and supporting primitives align strongly with the idea.

### Actor model: 7/10

All necessary actors exist conceptually, but partner subtype/organization context needs to become explicit.

### Orchestration: 8/10

The state machine fits the journey. Selection semantics and dealership continuity need refinement.

### AI: 8/10

Governed and appropriately advisory. Direct edge persistence needs a strict boundary.

### Coordination Engine: 8/10 architecture, 5/10 live signal completeness

The engine design is coherent; GIS/continuity signals are not yet populated.

### Spatial/GIS: 5/10

Correct architecture is defined but operational case geography is still incomplete.

### Frontends: 7/10

Role portals exist, but map/context projection is still too generic in places.

### Commerce: 8/10 foundation, 6/10 case-billing linkage

Commercial primitives exist; explicit completed-coordination metering should be tied to auditable case milestones.

### Overall current coherence: approximately 7.5/10

The remaining problems are integration problems, not a broken concept.

## 17. Correct implementation sequence

1. Introduce explicit provider recommendation vs selection semantics and selection mode.
2. Add originating-organization / continuity context to cases.
3. Add explicit partner subtype / organization operating context.
4. Create a role-scoped Core case-spatial contract.
5. Feed real ETA/distance into Coordination Engine.
6. Derive continuity only from authorized, meaningful case/provider relationships.
7. Replace generic Local embeds with role-specific case maps.
8. Add completed-coordination billing event semantics.
9. Surface AI / policy / coordination / spatial decision trace in Ops only.
10. Tighten Edge/Core AI persistence boundary and preserve one authoritative orchestration path.

## Final architecture statement

ROVIQ should be described and built as:

> **One ROVIQ Engine, centered on one service case, coordinating many independent actors through governed modules for intelligence, safety, policy, spatial context, ranking, commerce and audit.**

The front ends are role-specific windows into that one case system. The engines/modules do not pursue separate objectives. Their single objective is to complete the customer’s service journey with the right authorized actors, under partner controls, with continuity, choice where required, operational efficiency and a complete audit trail.
