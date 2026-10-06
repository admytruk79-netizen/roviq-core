# Feasible State-Space Solver

## Purpose
Extend Core from provider ranking into deterministic feasibility solving without replacing the existing guarded case workflow.

A candidate solution is a tuple of case requirements, actor capabilities, capacity, geography, time, cost and policy. Core first eliminates impossible states, then scores/ranks only the feasible set under the active versioned policy.

## Pipeline
1. Normalize case requirements into a constraint vector.
2. Build candidate capability states.
3. Apply hard eligibility and safety constraints.
4. Propagate dependent constraints (capacity, territory, timing, resource compatibility).
5. Produce a feasible candidate set with reason codes.
6. Apply the existing private/versioned routing policy only to feasible candidates.
7. Persist solver version, constraint checksum, candidate checksum and decision trace.
8. Execute through existing guarded state transitions.
9. Feed verified operational outcomes back into capability evidence, never directly into private ranking weights.

## Tesseract lessons adopted
- multidimensional state instead of one-dimensional provider lists;
- explicit relationship graph between resources/capabilities;
- constraint propagation before ranking;
- deterministic replay;
- capability envelopes;
- evidence-backed confidence;
- fail-closed unknowns;
- repair/alternative suggestions without bypassing hard constraints.

## Boundary
The solver does not replace routing policy, case state machines, access control or audit. It supplies a richer feasible state-space to them. AI may suggest hypotheses but cannot authorize an unsafe/ineligible state.
