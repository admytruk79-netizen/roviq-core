# ROVIQ Build Steps — Adaptive Front End + Conversational Core

Status: working build plan
Branch: `feature/drive-intent-router`
Updated: 2026-09-22

## Architecture decision

ROVIQ is one adaptive front-end system backed by one ROVIQ Core. Existing customer, dispatcher/admin, shop, tow, diagnostic and other front-end surfaces are retained and progressively unified through shared identity, actor context, permissions, conversation state and Core APIs. Do not rebuild an existing portal merely to add chat.

Android Auto is a constrained presentation surface of the same customer/driver experience, not a separate ROVIQ product.

## Build sequence

### 1. Conversational intent gateway — IN PROGRESS

- [x] Existing `POST /api/drive/intent`
- [x] Existing `POST /api/drive/respond`
- [x] Deterministic critical vehicle-safety override
- [x] Core → Local adapter retained
- [x] Expand classifier beyond Local/Vehicle
- [x] Add Journey intent
- [x] Add Mixed intent for vehicle + Local/Journey requests
- [x] Add Dispatch, Tow, Shop and Fleet intent classes
- [ ] Add Service intent deterministic patterns and tests
- [ ] Verify Local `/api/places` query contract before relying on free-text `q`

Target intents:
`LOCAL | VEHICLE | SERVICE | DISPATCH | TOW | SHOP | FLEET | JOURNEY | MIXED | GENERAL | UNKNOWN`

Safety-critical vehicle conditions always override discovery/routing requests.

### 2. Authenticated actor context — NEXT

Every conversation request must resolve the authenticated principal into existing Core data. Do not create a `drive_actor` identity.

Required context:
- principal / authenticated identity
- actor ID
- organization ID where applicable
- authorized role(s)
- permission/scopes
- current vehicle for customer/driver context
- active service case when applicable
- current journey/session when applicable

Build:
- `resolveConversationActor(request, sql)`
- `authorizeConversationCapability(actorContext, capability)`
- structured 401/403 responses
- actor-context audit event on consequential actions

Important: authorization is checked for every tool/action, not only at login.

### 3. Conversation/session context

Persist a shared session so follow-ups such as “something closer”, “not coffee, food”, “accept that job”, or “what about the second one?” work without repeating the original request.

Minimum session state:
- conversation/session ID
- actor ID
- active role/workspace
- active vehicle
- active service case
- active journey/destination
- last intent and entities
- last result references
- phone/Android Auto presentation source
- timestamps

The model receives only the context necessary for the current request.

### 4. Core chat tool registry

Workers AI interprets language; it does not receive independent authority. It proposes a narrowly defined capability, Core authorizes it, deterministic application code executes it, and the result is returned to the conversation layer.

Initial tool/capability set:
- `search_local_places`
- `get_local_place`
- `create_service_case`
- `get_case_status`
- `run_triage`
- `list_dispatch_queue`
- `assign_case`
- `list_tow_assignments`
- `accept_tow_job`
- `update_tow_status`
- `list_shop_jobs`
- `submit_estimate`
- `update_repair_status`
- `list_fleet_vehicles`
- `get_vehicle_status`
- `get_journey_context`

Never expose network-wide private capacity, competitor information, proprietary ranking weights or unrelated customer data through chat.

### 5. Automotive Knowledge Layer

Do not use the foundation model as the authoritative automotive database.

Create a retrieval layer with explicit provenance and confidence class.

Source classes:
1. ROVIQ-controlled safety and operating rules
2. authoritative/licensed automotive references
3. structured ROVIQ diagnostic knowledge
4. confirmed ROVIQ case outcomes
5. community/field evidence such as owner forums or Reddit

Community evidence may surface candidate patterns and natural driver language. It must not override deterministic safety rules or authoritative technical evidence.

Core knowledge objects should support:
- source/provenance
- vehicle applicability
- symptom/condition
- observation/test
- possible system/cause
- drivability/safety relevance
- recommended next question/action
- confidence/evidence class
- version/review state

### 6. Retrieval-augmented triage

Upgrade current triage:

`utterance → safety rules → vehicle/context resolution → knowledge retrieval → Workers AI assessment → Core policy → human review/next action`

Persist which knowledge records were used for every assessment so an assessment can be audited later.

### 7. Controlled learning loop

On completed cases preserve:
`reported symptom → ROVIQ assessment → diagnostic findings → confirmed diagnosis → repair/service → outcome`

Confirmed provider outcomes can improve future retrieval. They do not automatically rewrite safety rules, permissions or production routing policy.

### 8. Existing front-end integration

Integrate the conversational gateway into the front ends that already exist rather than replacing them.

Common component:
- Ask ROVIQ / chat
- same session contract
- same Core endpoint
- actor-aware capabilities
- role-specific quick actions/cards

Customer/driver: Drive, vehicle, Local, journey, cases.
Dispatcher/admin: queues, exceptions, assignment.
Tow: pickups, routing, ETA, handoff.
Shop/dealership: incoming work, scheduling/capacity, estimate, repair status.
Fleet: vehicles, downtime, approvals, mobility/loaners.
Diagnostic: assigned/claimable work, findings and downstream routing.

### 9. Android Auto

After the shared gateway/session contract is stable:
- voice-first Drive
- driving-safe templates
- Local Driver’s Picks and route stops
- vehicle concern intake
- navigation actions
- no video on vehicle display
- rich content/video handed off to phone
- shared phone/Auto session

### 10. Verification before merge

Required tests:
- coffee request → Local
- brake symptom → Vehicle
- critical brake failure + coffee → critical Vehicle
- tire warning + safe stopping place → Mixed
- scenic stop along route → Journey/Local context
- dispatcher queue request → Dispatch
- tow “next pickup” → Tow
- shop estimate request → Shop
- fleet downtime request → Fleet
- unauthorized actor attempting another role’s action → 403
- model output cannot bypass Core permission check
- session follow-up retains only appropriate context
- Local adapter behavior verified against current Local API

## Merge/deployment gate

Do not merge this branch to `main` or deploy it until:
1. actor/auth schema is verified against the live Core schema,
2. permissions are enforced server-side,
3. tests pass,
4. Local API query behavior is verified,
5. existing portals are regression-tested.
