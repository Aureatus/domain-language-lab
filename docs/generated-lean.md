# Generated Lean numeric adapter

**Status:** implemented restricted projection, not a full-action verification or
runtime correspondence proof. Includes an independent generic fixture; subsequent
[inventory integration](inventory-adapters.md) derives and checks a capacity kernel
from the actual reservation declaration. Read depth: README, design brief, semantic contract,
existing proof runner and Lean pilot read; selected shared runtime source inspected;
the adapter's generated proofs and differential cases independently executed.

## Reproduce

```sh
node --test adapters/lean/adapter.test.mjs
node adapters/lean/check.mjs
```

Uses `/tmp/opencode/elan/toolchains/leanprover--lean4---v4.19.0/bin/lean` by
default; `LEAN` can override the executable, but version **4.19.0** is mandatory.
No installation, root package edits, or changes to the existing proof pilot are
required. Default output is `adapters/lean/generated/`: `Generated.lean`,
`metadata.json`, `check.log`, and `report.json`. Tests retain their evidence in
`adapters/lean/test-output/`, including rejected mutant output.

For a later inventory fragment, export the complete shared IR and a separate
numeric obligation as JSON, then run:

```sh
node adapters/lean/check.mjs inventory-ir.json capacity-law.json adapters/lean/inventory-evidence
```

This command **projects** the selected numeric action kernel; it does not verify
the inventory action. Unsupported selected schemas/bindings/operators fail closed.

## Projection contract

Adapter `shared-ir-lean-numeric/1`, projection
`single-static-record-numeric-kernel/1`, consumes validated `semantic-core/v1`.
Exactly one binding with a literal record key selects one existing record. All
fields of its resource and all action inputs must have integer schemas. Additional
resources/actions are outside the projection. The entire source is still validated
by `validateModel`, retained, and hashed, including excluded declarations.

The generated state explicitly carries every selected field, its record version,
and global revision. This single-record representation assumes successful static
record lookup: there is no theorem about arbitrary resource maps or absent records.
Inputs include an explicit nonnegative safe-integer clock. Supported expressions:
integer/boolean literals, numeric input/field/clock, add/subtract, comparisons,
equality, not, eager and/or. Integer schema bounds are preserved. Unsupported
schemas (including selected string/boolean fields or inputs), dynamic/multiple
bindings, aliasing assignments, and unknown operators reject generation. Shared
IR typing is checked before projection; malformed Lean names also reject.

All **policies/authorization, actor/string semantics, relationships, observations,
routing, events, other resources/actions, commit tokens and concurrency** are
explicitly excluded. Rich excluded policies are neither proved nor assumed true.
There is no full-action entry point and no silent fallback to the approval pilot.

Lean uses `Int` with range `[-9007199254740991, 9007199254740991]` checked at
every arithmetic subtree. Both boolean operands' arithmetic is checked even when
the left determines truth. Ordered preconditions precede updates; updates evaluate
against the same original `s`, check destination schemas in declaration order,
and only then produce one candidate with revision/version increments. No-op writes
still increment the record version; an empty update group increments only revision.
Rejections never return a candidate state.

Result categories are numeric-kernel abstractions: `invalid` (any initial numeric
state/input/schema/range failure), `overflow`, `precondition`, `schema` (destination
bounds), or `committed`. Runtime input-schema rejection maps to kernel `invalid`;
runtime diagnostic text and exact invalid-input rejection codes are not preserved.
This is not a claim of full runtime observational equivalence.

## Independent obligation and evidence

`fixture.mjs` declares a generic capacity resource and decrement action in the
actual shared IR. `generate.mjs` traverses its schemas, preconditions and update
ASTs; `template.mjs` contains only emission/proof strategy, not capacity equations.
Changing an update changes the generated transition and source/generated hashes.

The separate `numeric-law/v1` obligation identifies an action, an `ensures` AST
using `pre`/`post` fields and inputs, and a concrete pre/input/post witness. The law
AST has mathematical (unbounded) arithmetic; it specifies a proposition, not runtime
execution. The fixture's law requires:

```text
post.remaining >= 0
post.remaining + input.amount = pre.remaining
```

`Generated.preserves` proves this for every successful generated numeric step.
Success entails valid numeric prestate/inputs, successful eager arithmetic and
the generated guards/schema checks. `Generated.positive_witness` checks a real
10-to-7 step, including grouped `previous = 10`, version and revision increments.
Thus the checked implication is not supported only by an unreachable success case.
The law is not inferred from the update and is not rewritten to accommodate mutants.

Evidence records full source/law content, stable IDs, canonical sorted-key JSON
SHA-256 hashes, generated Lean bytes, generator/template/runner/runtime hashes,
projection/exclusions/assumptions, exact Lean version (including reported commit),
and each theorem's transitive axiom report. Only Lean core `propext` is allowlisted;
the witness needs no axioms. No project axiom, `sorry`, native-decision trust escape,
or unsupported-construct success fallback is emitted. Trusted components include
Lean's kernel/core/Std, compiler and local toolchain, the JS generator, shared
validator, hash implementation, filesystem/process tools and report parser. Their
correctness is not itself proved.

Reports distinguish `proof_checked`, `not_checked` (Lean rejects the generated
declarations/proof attempt), `unsupported`, and `tool_error`. CLI success requires
`proof_checked`; absent/wrong tools, missing/unrecognized axiom reports or forbidden
axioms cannot pass. A failed tactic is not proof that an arbitrary law is false.

## Executed checks and boundaries

The adapter suite checks the positive proof, unsupported declarations, tool errors,
and an overselling mutant (`remaining - (amount + 1)`). The mutant is given its
correct positive witness, but cannot pass the unchanged capacity law. A separate
Lean/runtime execution confirms its changed transition, rather than relying only
on changed text or hashes.

Finite differential cases execute `createInterpreter` with allow-true policies,
then require Lean `by decide` equalities for the resulting numeric states or mapped
rejection categories. Cases cover upper/lower safe boundaries, intermediate
overflow that would cancel mathematically, eager boolean RHS overflow, revision
and version overflow, ordered precondition/update failure, and grouped prestate
reads. These are **tested mappings**, not a proof of translation/runtime
correspondence. No upstream suites were copied.

A runtime-only stale-token test also rejects a second commit against a changed
snapshot. There is deliberately **no generated stale-commit/concurrency theorem**.
Hosts still need atomic read-current/commit/replace-current/persistence, revalidation,
authentication and retry contracts from `semantic/CONTRACT.md`. Concurrent
reservations, full inventory behavior, distributed scheduling, persistence and
external effects remain unverified. The existing handwritten approval theorem
remains separate and is not used as evidence for this adapter.
