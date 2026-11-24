# Inventory v2: real reservation lifecycle

Status: executable consumer of `semantic-core/v2`, independent of the original
v1 inventory application. It creates reservation records with explicit caller IDs;
it has no preallocated/free slots and does not write domain state outside the
interpreter.

## Run

The unified browser workspace now exposes this profile alongside v1:
`npm run workspace`, then `http://127.0.0.1:4173`. See
[workspace UI](workspace-ui.md) for approval controls, live two-session updates,
restart/reconnect, derived forms/tools and browser verification.

```sh
node --test inventory/v2/*.test.mjs
node inventory/v2/demo.mjs
```

The demo writes actual SQLite results to `artifacts/inventory-v2-report.json`.
Each run creates an exclusive fresh database directory under
`/tmp/opencode/inventory-v2-demo-*`; it never deletes or reinitializes a user database.
Commands, identities and clocks are deterministic; temporary paths vary per run.
The test oracle calculates stock availability and reservation lifecycle separately
from the model/interpreter, and checks named concurrent-style reservations without
copying upstream interpreter tests.

## Model and IDs

`inventory/v2/model.mjs` exports `inventoryV2Model`, validated `initialState`,
`runtime`, and `invocation(id, kind, options)`. The seed has stock ID `camera`,
capacity/availability 8, and operator ID `warehouse`; reservations start empty.
Every reserve invocation supplies a new `reservationId` (for example
`res-alice-1`), `quantity`, and `expiresAt`. The interpreter's `inserts` declaration
creates that record at version 0 while grouped updates decrement stock.

- Quantities 1–2 need no approval. Quantity 3 or more requires the declared
  `reserve.warehouse-approval` policy; its approver expression reads the stock's
  `operator` field. The stock-capacity precondition still applies after approval.
- Owners cancel; the warehouse operator expires a reservation at/after its expiry.
  Both actions atomically restore stock and mark the reservation terminal.
- `reservation.delete-terminal` explicitly deletes cancelled/expired records. An
  active record cannot be deleted. Deleted IDs may be used again only in a later
  action, as specified by the v2 lifecycle contract.
- Expiry is invocation-driven, not a scheduler. Resume has a fresh explicit clock;
  policy, preconditions, and transition expressions are re-evaluated by v2.

## Executed durable acceptance

This supersedes the earlier pending-integration status. The CLI uses the real
`adapters/effect/durable.mjs` v2 API and Node SQLite, not an in-memory substitute:

1. Reserve quantity 3 at clock 100: pending; stock remains 8, no reservation or facts.
2. Close/reopen, then `durableApprove` with trusted-host identity `warehouse`.
3. Close/reopen, then `durableResume` at fresh clock 101: one new reservation,
   stock 5, one atomic action/change/create group carrying clock 101.
4. Reopen and retry: duplicate historical result, unchanged stock/outbox. A new
   resume ID rejects as consumed; the original reserve retry remains pending history.
5. Cancel as owner, restoring stock to 8; delete the terminal reservation explicitly.

Separate fresh databases demonstrate two rejection boundaries: a grant followed by
a real quantity-1 reservation changes stock to 7, so reopened resume rejects
`stale`; an otherwise unchanged granted request resumed at expiry clock 200 rejects
`precondition`. Neither publishes state/events or consumes the pending request.
Rejected operation outcomes themselves are persisted, not silently discarded.

The report contains full observed before/after state, outbox, pending projections,
API outcomes, checks and source/database paths. It is generated evidence, not an
independent semantic authority. `inventory/v2/durable.test.mjs` additionally runs
each phase in a separate Node process and compares availability against an
independent quantity oracle; the demo itself tests handle close/reopen only.

Read depth: full local README, inventory model, v2 contract and durable memo;
selected durable adapter source; independent execution of inventory tests/demo.
These are bounded acceptance examples, not proofs or power-loss/concurrency tests.
The trusted base includes the interpreter, Effect, Node/SQLite and filesystem.
Actors, approvers and clocks are explicit simulated trusted-host inputs, not real
authentication or wall-clock acquisition. No scheduler, delivery transport or
external exactly-once claim is added. See `docs/durable-execution.md` for storage
assumptions and `semantic/v2/CONTRACT.md` for the source lifecycle/approval laws.
