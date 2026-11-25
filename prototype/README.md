# Issue-tracker semantic experiment

Run with Node 22.18+ (native TypeScript stripping):

```sh
pnpm test
pnpm run demo
```

No dependencies or installation step. Node strips types; these commands do not run a TypeScript static type checker.

## What this tests

One declarative typed model defines a finite role/priority policy table, action precondition, grouped update and relationship recipient paths. A small interpreter supplies execution, a policy-diff function explains changed decisions, and a finite schedule explorer produces replayable counterexamples.

The demonstration changes support/high-priority resolution from approval-required to allowed. Separately, it explores all six permutations of approve/edit/execute after a request. A deliberately broken interpreter accepts any existing approval; its approve → edit → execute schedule violates the current-binding property. The normal interpreter rejects that stale approval. Both export simulated traces and storyboards.

## Artifacts

`pnpm run demo` writes five JSON files to `artifacts/`: policy diff, correct and mutant schedule explorations, safe replay and counterexample replay. These are actual interpreter outputs, unlike the earlier hand-authored fixture in `examples/`. Storyboard timing is editorial; no video is rendered.

## Semantics and boundaries

- One in-memory ticket and invocation; synchronous atomic commit; no persistence, process crashes or real network delivery.
- Actor roles are trusted inputs, not authenticated identities. Model/invocation edit methods are a simulation harness, not a public API or authorization boundary.
- Approval binds actor, arguments, invocation, complete ticket snapshot and complete model. This is deliberately conservative. Execute rechecks current policy and binding; repeated execution after completion is a no-op.
- Fixed injected clock; schedule and external actions are explicit. No production capabilities.
- Recipients derive from configured opener/watcher paths at commit. Set semantics deduplicate multiple paths. Delivery intents are in memory and do not establish durable or exactly-once delivery.
- The update IR supports only the listed status/summary/clock terms. No parser, arbitrary expressions, generic grouped-update compiler or schema-validation layer yet.
- Policy diff is complete for the six table contexts, not arbitrary program behavior. Schedule enumeration covers exactly one of each of three operations, not arbitrary retries, schedules or liveness.
- Trace events carry stable within-run IDs and semantic source references. Source references are declaration locators, not compiler source spans. The model is included and hashed, and each trace identifies whether the deliberate mutant was used; full build/toolchain evidence binding remains future work.
- The schedule oracle compares recorded approved/committed subjects independently of the interpreter's binding hash and diagnostic. It still trusts trace completeness, subject capture and the recorded policy decision. This is not an independently verified interpreter.
- No Effect/Alchemy integration or general rich UI renderer. The experimental workbench, generated-history testing/shrinking and separate Lean model pilot are now available; the Lean proof does not establish interpreter correspondence.

## Next experiment

See `docs/property-testing.md`, `docs/lean-pilot.md` and `docs/workbench.md` for the implemented expansion. Next establish correspondence and compare a real runtime adapter against the reference interpreter before increasing the guarantee. Keep law changes visible and measure whether deliberate mutants are detected.
