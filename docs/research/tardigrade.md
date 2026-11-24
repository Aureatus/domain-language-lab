# Tardigrade architectural reference

2026-11-14. Decision: retain as an architectural reference, endorsed by the user;
this is not a decision to integrate or replace our runtime.

## Evidence and read depth

Selected documentation: [introduction](https://tardigrade.sh/),
[atoms](https://tardigrade.sh/docs/atoms),
[libraries](https://tardigrade.sh/docs/concepts/libraries), and
[actor verification](https://tardigrade.sh/docs/verifying-actors).
Selected source inspection at commit
[`f0baf0dd99d536bfb218b39a5b72e9aa0762324b`](https://github.com/clavia-labs/tardigrade/tree/f0baf0dd99d536bfb218b39a5b72e9aa0762324b):
`packages/core/src/runtime/effects.ts`, `effect-request.ts`, and
`packages/tardie/package.json`. No independent execution, recovery audit or proof
audit was performed. Documentation URLs are mutable.

## Useful ideas and proposed applications

- **Reactive execution:** event-backed durable atoms, dependency-tracked derived
  atoms and effect proposals suggest finer-grained updates than our current
  relationship invalidations plus full-snapshot resynchronization. This does not
  establish incremental relational joins or lawful bidirectional propagation.
- **External-effect lifecycle:** inspected schemas distinguish durable effect
  identity, requested inputs, eventual-result handles, local attempt timeouts,
  cancellation decisions and cleanup outcomes. Use these distinctions when
  designing calendar/payroll integration; a local timeout is not evidence that a
  remote operation did nothing. Schema inspection alone establishes no delivery
  or recovery guarantee.
- **Typed libraries:** Effect services plus RPC contracts and host-supplied Layers
  are useful references for interchangeable real/test capabilities and generated
  tools. Authority and policy-derived approval remain semantic-core concerns;
  method typing alone grants no authority.
- **Generated service trajectories:** extend our generated command histories with
  delayed responses, stale observations, failures and competing completions.
  Preserve independent domain oracles and test our mappings.

## Adoption boundaries and open questions

The documented checker evaluates synchronous invariants on the empty history and
every event prefix. Only choices made through its `generate` mechanism are recorded
for shrinking/replay. Passing sampled trajectories is not a universal safety proof.
Verification examples use `tardie/deprecated/*`; newer atom/library APIs use newer
entry points. Compatibility must be established before recommending direct reuse.

Any future adapter needs an explicit mapping for grouped commits, implicit facts,
policy decisions, approval bindings and fresh-state resumption. Remote idempotency,
crash recovery, cancellation and model evolution require separate investigation.

A possible future experiment is calendar synchronization after approved leave,
including restart, timeout followed by late success, retry and cancellation. It is
a proposal only, not authorized implementation work or an adopted dependency.
