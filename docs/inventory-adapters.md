# Executed inventory adapter integration

**Status:** actual inventory Effect conformance tests and an executed, explicitly
restricted Lean numeric projection. Not a full inventory theorem, concurrency
theorem, or proof of runtime/translation correspondence. This document supplements
the generic adapter documented in `docs/generated-lean.md`.

Read depth: README, semantic contract and generated-Lean memo read; selected
inventory, Effect adapter, Lean generator/runner and existing adapter tests inspected.
The checks below were independently executed against these implementations.

## Reproduce

```sh
node --test inventory/adapters.test.ts adapters/lean/inventory.test.ts
node adapters/lean/inventory.ts
pnpm run proof:inventory # repository artifact destination
```

Executed result: **7 tests pass**, CLI reports **`proof_checked`**. Uses the existing
Effect installation under `adapters/effect/node_modules` and pinned Lean 4.19.0
through the existing generator/check APIs. Root scripts now include these checks.
`LEAN` may override the executable; the existing runner still requires 4.19.0.

Evidence is written outside the owned source files, to
`/tmp/opencode/inventory-evidence/`: `positive/` and `overselling/` contain generated
Lean, metadata, logs and reports. The positive CLI defaults to `positive/`; an
optional directory argument changes its destination. Tests also write
`actual-reserve.lean` and `actual-mutant.lean` with their execution logs. These are
regenerable local evidence, not committed fixtures or independent authorities.
The integrated command `pnpm run proof:inventory` writes the positive evidence to
`artifacts/inventory-proof/` for convenient inspection.

## Effect: full experimental inventory model, bounded tests

`inventory/adapters.test.ts` calls the existing Effect adapter with the actual
`inventory/model.ts` interpreter, not an action-name reimplementation. Tests cover:

- Reserve → cancel and reserve → early expiry rejection → expiry at the boundary.
  Every returned outcome, published state and routed event batch is compared with
  direct execution of the shared interpreter; independent stock/status expectations
  also check the domain outcome.
- Competing Effect fibers requesting three units each from five, using different
  slots/owners and both submission orders. An independent capacity oracle accepts
  either winner but requires exactly one commit, one precondition rejection,
  available stock two, one active three-unit slot, unchanged losing slot, revision
  and stock version one, and only the winner's events. Stock plus active quantities
  remains five. Retrying the winner must be a duplicate without publication.
- An injected pre-publication failure leaves state, events and the invocation ledger
  unchanged; retry can then commit.

This tests actual Effect execution with the adapter's in-process synchronized store.
It does not prove every schedule, distributed atomicity, durable persistence,
interrupt/cancellation safety, external delivery, or authentication. Conformance
comparison with the same interpreter is a mapping test, not an independent proof
of that interpreter; the race oracle supplies independent domain expectations.

## Lean: `inventory-stock-capacity/1`

`adapters/lean/inventory.ts` validates the complete original inventory AST, then
extracts integer stock schemas (`capacity`, `available`), the `quantity` input
schema, `reservation.reserve.capacity` guard and
`reservation.reserve.set.available` update **from that AST**. There are no duplicate
handwritten transition equations. The original binding ID
`reservation.reserve.stock` is preserved, but its `input(stockId)` key is explicitly
specialized to literal `camera`, assuming that record exists.

The versioned projection pins the full source structure/content except the two
retained numeric expression trees. Changed schemas, bindings, guard/update lists,
excluded declarations, IDs or policies require explicit projection review and
versioning; they cannot silently refresh a baseline. Retained expressions are
traversed and reject dependencies outside integer stock fields, `quantity`, numeric
or boolean literals and supported numeric/boolean operators. Slot fields,
`expiresAt`, clock reads, actor and unsupported operators fail closed. Supported
numeric edits are actually translated, rather than rejected just because their
equation differs from the original.

Each inventory report contains the **complete original source**, canonical
sorted-key JSON SHA-256, original model ID, projected hash, exact retained and
excluded semantic-ID lists covering the entire original model, retained/excluded
schema paths, binding specialization, exclusions and assumptions. The inventory
adapter implementation is hashed too. For the executed source the full AST hash is:

```text
634e40370adae96a5ba3d07b3ed6a4beea1ec9fa7c7b3b1a373b546d1b6aba56
```

The existing generator/check runner separately records projected source and law,
generator/template/runner/shared-core hashes, generated Lean hash, exact tool
version and theorem axiom reports. The original source hash is **not** the projected
model hash, nor a claim of a raw source-file byte hash.

### Explicit exclusions

The other reserve guards (`matchingStock`, `expectedStatus`, `futureExpiry`), every
policy/authorization outcome, reservation slot/binding/fields/writes, owner/status
checks, nonnumeric stock fields, other inputs/actions, relationships, observations,
routing and events are excluded. So are missing records, commit tokens, stale
snapshots, concurrency and host publication. Full inventory remains **unsupported**
by the original numeric generator; a test checks that rejection. The projected
model intentionally has no allow policy: it is input to the numeric generator, not
a replacement authorized application model.

### Independent law, real witness, mutant

The separately declared `numeric-law/v1` obligation says:

```text
post.available >= 0
post.available + quantity = pre.available
```

Lean's kernel checks this for every successful generated numeric step, and checks
a concrete `capacity=5, available=5, quantity=3` step to `available=2` with revision
and record version incremented. Safe-integer bounds, intermediate overflow checks,
numeric input bounds and successful numeric guards/schema checks remain in scope.
`capacity` is retained unchanged, but no stronger `available <= capacity` invariant
is claimed for arbitrary prestates.

An edited **original inventory** reserve update subtracting `quantity + 1` changes
the full original hash, projected hash and generated code. Its corrected witness
is 5→1 with quantity three; Lean checks that witness but rejects the unchanged
conservation law (`not_checked`, with the failed proof log retained). A failed
tactic alone is not evidence of arbitrary falsity: here 1+3≠5 is a concrete
counterexample. Independent Lean `by decide` executions are cross-checked against
the actual inventory interpreter for the original successful/boundary/rejected
reserve cases and the changed mutant transition.

The theorem is about this generated numeric kernel only. Translation correctness
is tested finitely, not proved. Trusted components include the projection and
generator, shared validator, JS/tool/filesystem/hash/report machinery and Lean's
pinned kernel/core/Std/toolchain; only the existing `propext` axiom allowlist is
accepted. No full reservation, inventory conservation across actions, authorization,
event, concurrent reservation or Effect/Lean correspondence theorem is claimed.
