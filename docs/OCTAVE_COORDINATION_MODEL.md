# ROVIQ Recursive Octave Coordination Model

## Purpose

Use the octave as a coordination grammar for ROVIQ Core without replacing existing domain logic.

ROVIQ already has the correct substrate: one canonical Case, guarded state transitions, immutable events, role-specific surfaces, sagas, deadlines, fallback processing, exception queues, pricing, parts, transport, mobility, Shop OS, fleet and payments.

The octave model sits above those modules as a process-orchestration abstraction.

## Core abstraction

A process develops through seven stages and resolves into a higher-order state:

1. DO — establish the case/state
2. RE — gather/extend information
3. MI — reach a decision-ready state
4. FA — first intervention/shock: branch, escalate, approve, reroute or transform
5. SOL — execute the chosen path
6. LA — integrate dependent work
7. SI — verify readiness for closure
8. DO² — resolve and promote to the next stable state

The two transition points are not mystical system rules. In Core they are explicit operational intervention points where ordinary progression is insufficient.

## Recursive branching

Any stage may open a subordinate octave. The parent remains authoritative while child workflows execute independently and later reconverge.

Example:

Case
- diagnostics octave
  - intake
  - evidence
  - test
  - diagnosis decision
  - estimate
  - approval readiness
  - diagnostic close
- transport octave
- parts octave
- repair octave
- payment octave

Full branching is never required. Recursion is bounded by policy, case type, capacity, risk and deadline.

## Mapping to existing ROVIQ modules

### Customer
DO request -> RE intake -> MI confirm need -> FA approval/choice -> SOL service begins -> LA updates/coordination -> SI completion review -> DO² resolved customer state.

### Diagnostic
DO assignment -> RE evidence capture -> MI assessment -> FA escalation/second test/authorization -> SOL confirmed diagnostic work -> LA attach findings to service plan -> SI diagnostic verification -> DO² diagnostic complete.

### Tow / Valet
DO transport need -> RE eligibility/capacity -> MI dispatch-ready -> FA reroute/manual intervention -> SOL pickup/transit -> LA handoff -> SI proof of delivery -> DO² transport complete.

### Partner / Shop OS
DO repair order -> RE schedule/resources -> MI estimate/work-plan readiness -> FA customer approval/parts exception -> SOL work execution -> LA DVI/parts/labor integration -> SI QC/completion -> DO² repair complete.

### Parts
DO demand -> RE source availability -> MI reservation decision -> FA substitution/reroute/backorder intervention -> SOL fulfillment -> LA delivery to work order -> SI receipt/fit verification -> DO² fulfilled.

### Fleet / Mobility
DO mobility requirement -> RE resource eligibility -> MI allocation-ready -> FA alternate vehicle/provider intervention -> SOL allocation -> LA usage/return coordination -> SI return verification -> DO² mobility complete.

### Payments
DO amount due -> RE intent/setup -> MI authorization-ready -> FA retry/review/dispute intervention -> SOL capture/payout/refund -> LA reconciliation -> SI financial verification -> DO² settled.

### Inventory / Trade
DO vehicle demand -> RE verified listing/source -> MI eligible candidate set -> FA negotiation/availability exception -> SOL reservation/purchase workflow -> LA title/export/logistics integration -> SI compliance/asset verification -> DO² acquired/export-ready.

### Operations / Admin
Ops is not another ordinary octave. It is the supervisory layer that sees parent and child octaves, unresolved shocks, missed deadlines and failed reconvergence.

## Shock types

A shock is an explicit Core event:
- approval required
- capacity unavailable
- provider rejected
- diagnostic uncertainty
- inventory unavailable
- price changed
- payment failed
- deadline missed
- policy requires review
- customer changes choice
- dependent child workflow failed

Every shock must be auditable and have a deterministic response class: continue, branch, reroute, escalate, wait, rollback or terminate.

## Reconvergence

Child processes must never leave the parent Case in an ambiguous state.

A child octave closes with:
- completion evidence
- outcome status
- unresolved blockers
- next parent transition
- audit event
- idempotent result token where external retries are possible

The parent advances only when required children have satisfied their reconvergence contracts.

## Why this helps

The model gives ROVIQ one common coordination language across all modules:

state -> progress -> intervention -> execution -> integration -> verification -> resolved state

It also makes cross-module workflows easier to visualize and test without merging bounded modules into one giant workflow.

## Implementation direction

1. Keep current domain states untouched.
2. Add an optional orchestration projection that maps domain events to octave stage + parent/child process.
3. Add shock classifications to existing exception/saga infrastructure.
4. Add reconvergence contracts for child sagas.
5. Expose the projection in Ops as a process tree/timeline.
6. Test replay deterministically from immutable events.
7. Never allow the abstraction to bypass existing authorization, policy, payment, partner-isolation or safety rules.
