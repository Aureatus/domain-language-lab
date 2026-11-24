# Derived capability backlog

Recorded 2026-11-11. The user endorsed all eight directions below. They are research/product goals, not implemented guarantees.

## 1. Semantic diffs

Explain changes to permissions, reachable behavior, dependencies, screens, subscriptions, infrastructure and evidence. Provide witnesses showing old/new outcomes. Initially compare a finite declared policy domain; general behavioral equivalence is a separate problem. Never describe a text diff as complete semantic analysis.

## 2. Why and why-not explanations

Explain visibility, unavailable actions, notification recipients, waiting workflows and provisioning decisions through actual rule/dependency provenance. Offer counterfactual prerequisites while respecting authorization and explanation visibility. Missing permission is not authority to grant it.

## 3. Counterexamples as debugging experiences

Normalize checker witnesses into minimal reproductions, regression scenarios, state-by-state replay, causal explanations and optional video storyboards. Preserve abstract/concrete and simulated/observed labels. Agents repair implementation against unchanged requirements, or explicitly propose requirement changes.

## 4. What-if laboratory

Substitute simulation interpreters for time, external services, randomness and scheduling. Explore cancellation, remote uncertainty, relationship races and policy changes. Derive reproducible demos and synthetic fixtures without production side effects.

## 5. Executable architecture and runbooks

Connect interface intent to action, effects, infrastructure, failures and recovery paths. Combine declared topology with observed traces to explain incidents and stalled work. Recovery actions retain ordinary policy checks; unknown external behavior remains visible.

## 6. Migration and compatibility planning

Analyze impacts on stored data, pending invocations/approvals, event history, offline clients and renderer contracts. Generate unambiguous transformations and surface business choices explicitly. Example: a new required argument needs migration, a versioned handler or explicit cancellation of pending invocations.

## 7. Synthesized tests and adversarial environments

Derive valid graphs, boundary data, action histories, duplicate/out-of-order delivery, provider failures and renderer stress scenarios. Deliberate mutants test specification adequacy: a sorting law that accepts always-empty output is insufficient. Generated coverage is not exhaustive proof.

## 8. Aligned agent interfaces

Derive discoverable tools, typed arguments/results, scoped capabilities, previews, availability, pending/completed outcomes and structured explanations from the same action contracts used by UI and APIs. Tool discovery does not itself grant authority.

## Combined experience

Agent proposes change → semantic diff → generated scenarios → counterexample → replay/explanation → repair → evidence refresh. Law changes are reviewed semantic changes, never a silent way to obtain a passing result.

## Priority

First demonstrate a policy change and a stale-approval race using a typed model, deterministic interpreter, finite scenario exploration and machine-readable explanation. Next add property generation/shrinking and a small Lean proof pilot. Renderer, provider integration, video and generalized semantic analysis remain subsequent work.
