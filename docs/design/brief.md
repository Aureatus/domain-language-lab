# Design brief

Status: proposed architecture, 2026-11-11.

## Core goal

Declare enough application meaning once that execution, rich interfaces, infrastructure requirements, explanations and verification obligations can be faithfully derived. Keep custom syntax and a TypeScript DSL as candidate frontends over the same typed semantic representation.

The language is a family of connected semantic regions, not a claim that arbitrary code becomes statically knowable:

1. Domain: resources, relationships, queries, actions, policies and types.
2. Execution: pure computations, transitions, effects, durable invocations and events.
3. Interaction: local state, commands, focus, navigation and lifecycle.
4. Deployment: requirements and mappings to Alchemy/provider resources.
5. Laws: invariants, pre/postconditions, temporal properties and correspondence obligations.
6. Explanations: identity/provenance links across all of the above.

Use stable IDs and source mappings across regions. Version and hash semantic content independently from incidental formatting; include presentation content when hashing presentation artifacts.

## Determinism

Deterministic elaboration means the same source, dependencies and configuration yield the same semantic artifact. Deterministic simulation also requires a specified clock, random stream, inputs, scheduling decisions and external results. Production distributed systems still have nondeterministic arrival and failure behavior. Represent it rather than pretending it disappears.

## Domain decisions carried forward

- Authorization can yield allow, deny or approval-required. Approval is derived infrastructure; pending invocation remains a distinct result. Approval does not override unrelated denial.
- Policies, action preconditions and implementation are separate concepts.
- A grouped `set` is an atomic patch with expressions evaluated against the prior state; sequential computation must be explicit. This remains a proposed semantics, not settled syntax.
- Derive committed action/change facts implicitly; explicit business events add meaning.
- Relationship profiles plus per-action metadata derive observation, reactions and communication. One-way and two-way configurations do not require per-action routing boilerplate.
- Define retries and duplicate handling at actual side-effect boundaries. An SDK retry is not safe mutation replay.

## Rich UI and adapters

A rich workspace includes split panes, tabs, command palettes, focus, keyboard scopes, streaming conversations, virtualized lists, editors, terminals, diffs and native surfaces. Domain-driven forms are one derived feature.

Adapters declare versioned capability profiles and preserve observable interaction contracts. They may adapt layout and gestures by platform. A host widget or service integration uses typed scoped interfaces, lifecycle and trace contracts; untrusted executable code needs actual confinement. Unknown foreign behavior is an explicit analysis boundary.

Foldkit and React are candidate web renderers; native libraries such as GPUI and the user's suggested Rune remain adapter targets to investigate, not compatibility claims. No Rune API has been assumed.

## Verification and outputs

Verification and explanatory outputs are first-class consumers of the semantic model, alongside runtime/UI adapters. Use specialized contracts for each; do not flatten their obligations into an uninformative universal adapter interface.

The same source-mapped counterexample should be usable as a regression fixture, debugger replay, diagram path and video storyboard. Evidence is separately linked and never strengthened by presentation.

## Open decisions

- Minimum total pure core, numeric semantics and foreign-model interface.
- Transaction/revalidation point for approvals and policy changes.
- Definition of action success for mixed local/remote operations.
- Recipient snapshot semantics and revocation at delivery time.
- Local statechart scheduling versus distributed concurrency semantics.
- Capability profiles and the portability boundary for native widgets.
- Frontend syntax and typed IR format.
- Scope of initial formal guarantees and translation correspondence.

See [laws and scenarios](laws-and-scenarios.md) and [outputs](outputs.md) for proposed acceptance behavior.
